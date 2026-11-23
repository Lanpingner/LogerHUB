import {
  HELLO_DEFAULTS,
  LEVELS,
  type BatchFrame,
  type HelloFrame,
  type Level,
  type LogEntry,
  type NackFrame,
} from '@logguber/shared'
import { createBatcher } from './batcher'
import { redactBody, truncateJson } from './redact'
import { createSpool, type Spool } from './spool'
import { createTransport, type Transport, type TransportState } from './transport'
import { ulid } from './ulid'
import type { Logger, LoggerOptions, LogOptions } from './types'

const DEFAULT_MAX_ENTRIES = 100
const DEFAULT_MAX_MS = 1000
const DEFAULT_MAX_QUEUE = 10_000
/** One report per cause per window, so a permanent failure cannot flood the host's logs. */
const ERROR_INTERVAL_MS = 5000
const ERROR_KEY_LIMIT = 64
const FLUSH_TIMEOUT_MS = 1000
const CLOSE_TIMEOUT_MS = 1000
const SETTLE_POLL_MS = 5
/** A gateway that nacks is overloaded or restarting: wait before offering the batch again. */
const NACK_RETRY_DELAY_MS = 2000
/**
 * A send refused while the transport still reports `open` means the socket sits in ws's CLOSING
 * state, which lasts until its closing handshake finishes — up to ws 8.23.0's 30s close timeout.
 * Retries start here and back off to `SEND_RETRY_MAX_MS`, so a long CLOSING window costs a
 * handful of claim-and-release cycles against the spool file rather than twenty a second.
 */
const SEND_RETRY_DELAY_MS = 50
const SEND_RETRY_MAX_MS = 1000
const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))

/** Finite integer >= 1, otherwise the fallback. */
function sane(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Rate-limits reports per distinct cause and swallows anything the hook throws. Both the
 * transport (every failed reconnect) and the spool (while unrecoverable) report continuously,
 * and a hook that logs through this same logger would otherwise feed itself.
 */
function createReporter(hook?: (e: Error) => void): (source: string, e: unknown) => void {
  const lastSeen = new Map<string, number>()
  let lastDefault = 0
  let inside = false
  const emit =
    hook ??
    ((e: Error): void => {
      const now = Date.now()
      if (now - lastDefault < ERROR_INTERVAL_MS) return
      lastDefault = now
      console.warn(`[logguber] ${e.message}`)
    })

  return (source, raw) => {
    if (inside) return // a hook that logs through this logger must not recurse
    const e = toError(raw)
    const key = `${source}:${e.message}`
    const now = Date.now()
    const prev = lastSeen.get(key)
    if (prev !== undefined && now - prev < ERROR_INTERVAL_MS) return
    if (lastSeen.size >= ERROR_KEY_LIMIT) {
      let evicted = 0
      for (const [k, t] of lastSeen) {
        if (now - t < ERROR_INTERVAL_MS) continue
        lastSeen.delete(k)
        evicted++
      }
      // Churning through distinct causes faster than the interval must still not grow the map:
      // a Map iterates in insertion order, so the first key is the oldest one we hold.
      if (evicted === 0) {
        const oldest = lastSeen.keys().next().value
        if (oldest !== undefined) lastSeen.delete(oldest)
      }
    }
    lastSeen.set(key, now)
    inside = true
    try {
      emit(e)
    } catch {
      // Nothing may throw into application code, least of all the error path.
    } finally {
      inside = false
    }
  }
}

/** Undelivered batches, oldest first. Either the SQLite spool or a bounded in-memory stand-in. */
interface Store {
  push(b: BatchFrame): void
  claim(n: number): BatchFrame[]
  /** Delivered or permanently rejected: forget it. */
  ack(id: string): void
  /** Not delivered after all: make it claimable again. */
  release(id: string): void
  /** Cumulative batches lost to the store's own bounds. Never resets. */
  prunedCount(): number
  close(): void
}

function spoolStore(spool: Spool): Store {
  return {
    push: (b) => spool.push(b),
    claim: (n) => spool.claim(n).map((r) => r.batch),
    ack: (id) => spool.ack(id),
    release: (id) => spool.release(id),
    prunedCount: () => spool.prunedCount(),
    close: () => spool.close(),
  }
}

/** Used when no spool is configured, or the configured one is unusable. Dies with the process. */
function memoryStore(maxBatches: number): Store {
  const queue: BatchFrame[] = [] // unclaimed, oldest first: ULID ids sort by mint time
  const claimed = new Map<string, BatchFrame>()
  let pruned = 0

  const insert = (b: BatchFrame): void => {
    let i = queue.length
    while (i > 0 && queue[i - 1].id > b.id) i--
    queue.splice(i, 0, b)
  }

  return {
    push(b) {
      insert(b)
      while (queue.length > 0 && queue.length + claimed.size > maxBatches) {
        queue.shift()
        pruned++
      }
    },
    claim(n) {
      const out = queue.splice(0, n)
      for (const b of out) claimed.set(b.id, b)
      return out
    },
    ack: (id) => void claimed.delete(id),
    release(id) {
      const b = claimed.get(id)
      if (b === undefined) return
      claimed.delete(id)
      insert(b)
    },
    prunedCount: () => pruned,
    close() {
      queue.length = 0
      claimed.clear()
    },
  }
}

const isLevel = (v: unknown): v is Level => typeof v === 'string' && (LEVELS as readonly string[]).includes(v)

function timestamp(v: unknown): string {
  return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : new Date().toISOString()
}

/**
 * Keeps string dimensions, stringifies the other primitives, drops everything else. Fail-closed
 * per source: a throwing getter or a hostile proxy costs that source's dimensions and is
 * reported, never the log call. Enumerating a caller's object is the one step here that can
 * run foreign code.
 */
function mergeDims(
  sources: Array<Record<string, unknown> | undefined>,
  onError?: (e: unknown) => void,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const source of sources) {
    if (source === null || typeof source !== 'object') continue
    try {
      for (const [k, v] of Object.entries(source)) {
        if (typeof v === 'string') out[k] = v
        else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v)
      }
    } catch (e) {
      onError?.(e)
    }
  }
  return out
}

/** `meta` must be a JSON object on the wire; a redacted primitive is wrapped rather than dropped. */
function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v }
}

/** Anything resembling a log entry: a level method's arguments, or a pino/winston record. */
export interface RawEntry {
  ts?: unknown
  level?: unknown
  kind?: unknown
  msg?: unknown
  dims?: Record<string, unknown>
  meta?: unknown
}

export interface LoggerCore {
  /** Normalises, redacts and enqueues. Synchronous, non-blocking, and never throws. */
  accept(raw: RawEntry, dims?: Record<string, unknown>): void
  /** `child()`'s merge, done here so a hostile source is reported rather than thrown. */
  mergeChildDims(parent: Record<string, string>, extra?: Record<string, unknown>): Record<string, string>
  flush(): Promise<void>
  close(): Promise<void>
}

/** Internal test seams, kept off the public options. Not for the package index to re-export. */
export interface CoreHooks {
  /** Wraps the transport, to drive refusals a real socket cannot be scheduled into. */
  wrapTransport?: (t: Transport) => Transport
}

/**
 * Wires batcher -> transport -> store. Shared by `createLogger` and `createSink`: a log call
 * enqueues, the batcher cuts, the transport sends, and whatever the gateway does not
 * acknowledge ends up in the store to be replayed oldest first.
 */
export function createCore(opts: LoggerOptions): LoggerCore {
  return buildCore(opts, {})
}

export function buildCore(opts: LoggerOptions, hooks: CoreHooks): LoggerCore {
  const report = createReporter(opts.onError)
  const baseDims = mergeDims([opts.dims], (e) => report('dims', e))
  const mode = opts.spool?.mode ?? 'on-failure'
  const maxEntries = sane(opts.batch?.maxEntries, DEFAULT_MAX_ENTRIES)
  const maxQueue = sane(opts.batch?.maxQueue, DEFAULT_MAX_QUEUE)

  let spool: Spool | undefined
  if (opts.spool !== undefined) {
    spool = createSpool({
      dir: opts.spool.dir,
      maxBytes: opts.spool.maxBytes,
      maxAge: opts.spool.maxAge,
      onError: (e) => report('spool', e),
    })
    if (!spool.available()) {
      // An unusable spool costs durability, never the logger: carry on in memory.
      report('spool', new Error(`spool at ${opts.spool.dir} is unavailable; logging in memory only`))
      spool.close()
      spool = undefined
    }
  }
  const store: Store =
    spool !== undefined ? spoolStore(spool) : memoryStore(Math.max(1, Math.ceil(maxQueue / maxEntries)))

  let ackWindow: number = HELLO_DEFAULTS.ackWindow
  let reportedPruned = 0
  let retryNotBefore = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * This process has batches in the store. Scoped to our own work on purpose: a sibling
   * worker's backlog in a shared spool directory must not push a healthy worker's live
   * batches through the disk, nor keep its `flush` waiting.
   */
  let stored = false
  let draining = false
  /** Grows while sends are refused, back to its floor on the first that is not. */
  let sendRetryDelay = SEND_RETRY_DELAY_MS
  let closed = false
  let closing: Promise<void> | undefined
  /** Batches handed to the transport, so a nack can find the body and an ack the store row. */
  const sent = new Map<string, { batch: BatchFrame; fromStore: boolean }>()

  const batcher = createBatcher({
    maxEntries,
    maxMs: sane(opts.batch?.maxMs, DEFAULT_MAX_MS),
    maxQueue,
    onBatch,
    onError: (e) => report('batcher', e),
  })

  const transport = (hooks.wrapTransport ?? ((t: Transport) => t))(createTransport({
    url: opts.url,
    apiKey: opts.apiKey,
    service: opts.service,
    env: opts.env,
    backoff: opts.backoff,
    onAck,
    onNack,
    onState,
    onHello,
    onError: (e) => report('transport', e),
  }))

  function onBatch(entries: LogEntry[], droppedSinceLast: number): void {
    // The batcher counts dropped entries and resets on read; the store counts pruned batches
    // and never resets, so take its delta. Two units: reported side by side, never summed.
    const prunedDelta = Math.max(0, store.prunedCount() - reportedPruned)
    reportedPruned += prunedDelta
    const batch: BatchFrame = { t: 'batch', id: ulid(), entries }
    if (droppedSinceLast > 0) batch.droppedSinceLast = droppedSinceLast
    if (prunedDelta > 0) batch.prunedBatchesSinceLast = prunedDelta
    // `always` keeps a copy before the wire; otherwise the store is only for what cannot go
    // now, and anything of ours already in it takes precedence so replay stays oldest first.
    if (closed || mode === 'always' || stored || !offer(batch, false)) {
      keep(batch)
      drain()
      return
    }
  }

  /** `transport.send` plus the bookkeeping a successful send implies. */
  function offer(batch: BatchFrame, fromStore: boolean): boolean {
    if (!transport.send(batch)) return false
    sendRetryDelay = SEND_RETRY_DELAY_MS
    sent.set(batch.id, { batch, fromStore })
    return true
  }

  /** Every write to the store goes through here, so the hot-path flag cannot drift. */
  function keep(batch: BatchFrame): void {
    store.push(batch)
    stored = true
  }

  function onHello(h: HelloFrame): void {
    // The transport clamps these already; clamping again is cheap, and a zero here would
    // stall the batcher for the process's lifetime.
    ackWindow = sane(h.ackWindow, HELLO_DEFAULTS.ackWindow)
    batcher.setLimits({ maxEntriesPerBatch: sane(h.maxEntriesPerBatch, HELLO_DEFAULTS.maxEntriesPerBatch) })
  }

  function onState(s: TransportState): void {
    if (s !== 'open') return
    retryNotBefore = 0 // a fresh connection is reason enough to offer a nacked batch again
    drain()
  }

  function onAck(id: string): void {
    sent.delete(id)
    store.ack(id) // a no-op when the batch was never stored
    drain() // an ack frees a window slot
  }

  function onNack(f: NackFrame): void {
    const rec = sent.get(f.id)
    sent.delete(f.id)
    if (!f.retryable) {
      store.ack(f.id) // a permanent rejection: retrying it forever would block everything behind it
      return
    }
    if (rec !== undefined && !rec.fromStore) keep(rec.batch)
    else {
      store.release(f.id)
      stored = true
    }
    retryNotBefore = Date.now() + NACK_RETRY_DELAY_MS
    scheduleRetry(NACK_RETRY_DELAY_MS)
  }

  /**
   * One pending nudge, so a nacking gateway is retried on a timer rather than in a loop. A
   * request made while a timer is already armed is dropped rather than merged, so a 2s nack
   * floor wins over a shorter send-refusal delay — which is the right way round, but it does
   * mean a nudge is "as soon as the floor allows", not "shortly".
   */
  function scheduleRetry(delayMs: number): void {
    if (closed || retryTimer !== undefined) return
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      drain()
    }, Math.max(0, delayMs))
    retryTimer.unref?.()
  }

  /** Sends stored batches oldest first, up to the free ack window. Event-driven: never a spin. */
  function drain(): void {
    if (closed || draining || transport.state() !== 'open') return
    const wait = retryNotBefore - Date.now()
    if (wait > 0) {
      // A later nack can push the floor past the pending timer, so re-arm for the remainder:
      // without this the store waits for an unrelated event that a quiet gateway never sends.
      scheduleRetry(wait)
      return
    }
    draining = true
    try {
      for (;;) {
        const free = ackWindow - transport.inFlight()
        if (free <= 0) return
        const claimed = store.claim(free)
        if (claimed.length === 0) {
          // Nothing claimable and nothing of ours outstanding: our work is done, so live
          // batches may go straight to the wire again without overtaking anything.
          if (transport.inFlight() === 0) stored = false
          return
        }
        for (let i = 0; i < claimed.length; i++) {
          const batch = claimed[i]
          if (offer(batch, true)) continue
          // Normally unreachable, read out of ws 8.23.0 rather than assumed. `send` throws
          // only when readyState is CONNECTING, which `transport.send`'s own OPEN check
          // excludes; a non-OPEN readyState and a full ack window cannot arise inside this
          // synchronous loop; and the duplicate-id refusal needs an unclaimed row whose id is
          // still pending, which nothing produces (`storeInFlight` writes only when closing or
          // when the stream is down, and `close()` sets `closed` before calling it, so no
          // drain follows). One real window remains: readyState CLOSING, which ws holds until
          // the closing handshake completes — up to its 30s close timeout — while the
          // transport still reports `open`. So hand back every claim we cannot honour,
          // remember the work, and ask for another attempt; otherwise these rows sit
          // unclaimable until the claim expires (`staleClaimMs`, 60s by default) and nothing
          // else is guaranteed to wake the drain.
          for (let j = i; j < claimed.length; j++) store.release(claimed[j].id)
          stored = true
          scheduleRetry(sendRetryDelay)
          sendRetryDelay = Math.min(SEND_RETRY_MAX_MS, sendRetryDelay * 2)
          return
        }
        if (claimed.length < free) return // the store had nothing more to give
      }
    } finally {
      draining = false
    }
  }

  /** Waits for the store to empty and every sent batch to be acked, or for the deadline. */
  async function settle(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (stored || transport.inFlight() > 0) {
      if (Date.now() >= deadline) return
      await delay(SETTLE_POLL_MS)
      drain()
    }
  }

  /**
   * A batch the gateway has not acked is only durable once it is stored. One sourced from the
   * store already is; one sourced from memory is lost on exit, which is exactly the SIGTERM
   * case the spool exists for.
   */
  function storeInFlight(final: boolean): void {
    // On a healthy stream the ack is still coming, and `on-failure` promises the disk stays
    // untouched; only a last chance (closing, or a stream that is down) earns a write.
    if (!final && transport.state() === 'open') return
    for (const batch of transport.inFlightBatches()) {
      const rec = sent.get(batch.id)
      if (rec?.fromStore === true) {
        // Its row exists but is claimed by a process that is about to exit. Hand it back, or
        // the next one waits out the claim expiry before replaying it.
        if (final) store.release(batch.id)
        continue
      }
      keep(batch)
      if (rec !== undefined) rec.fromStore = true // so a late ack deletes the row we just wrote
    }
  }

  async function shutdown(): Promise<void> {
    batcher.close() // cuts whatever is queued through onBatch
    drain()
    await settle(CLOSE_TIMEOUT_MS)
    closed = true
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    retryTimer = undefined
    storeInFlight(true) // before close(), which forgets the transport's pending batches
    await transport.close()
    store.close()
  }

  /** Builds, redacts and queues one entry. Only `accept` calls it, and only inside a try. */
  function enqueue(raw: RawEntry, dims?: Record<string, unknown>): void {
    const entry: LogEntry = {
      ts: timestamp(raw.ts),
      level: isLevel(raw.level) ? raw.level : 'info',
      msg: typeof raw.msg === 'string' ? raw.msg : String(raw.msg ?? ''),
    }
    if (raw.kind === 'request') entry.kind = 'request'
    const merged = mergeDims([baseDims, dims, raw.dims], (e) => report('dims', e))
    if (Object.keys(merged).length > 0) entry.dims = merged
    if (raw.meta !== undefined) {
      // Redaction and truncation happen here, before the queue, so no secret ever reaches
      // the network or the disk.
      const meta = truncateJson(redactBody(raw.meta, { redactKeys: opts.redactKeys }))
      if (meta !== undefined) entry.meta = asRecord(meta)
    }
    batcher.push(entry)
  }

  return {
    accept(raw, dims) {
      try {
        enqueue(raw, dims)
      } catch (e) {
        // A hostile `msg.toString`, dimension getter or proxy must cost the entry, never the
        // caller's request. Reachable through createSink(), where a foreign logger built the record.
        report('accept', e)
      }
    },

    mergeChildDims: (parent, extra) => mergeDims([parent, extra], (e) => report('dims', e)),

    async flush() {
      if (closing !== undefined) {
        await closing
        return
      }
      batcher.flush()
      drain()
      await settle(FLUSH_TIMEOUT_MS)
      storeInFlight(false)
    },

    close() {
      if (closing === undefined) closing = shutdown()
      return closing
    },
  }
}

/** `owned` is false for a child: it shares the pipeline and must not be able to close it. */
function wrap(core: LoggerCore, dims: Record<string, string>, owned: boolean): Logger {
  // The call's own dimensions travel on the entry so that merging them — the one step that can
  // run a caller's getter — happens inside `accept`, where nothing escapes.
  const log = (level: string, msg: string, o?: LogOptions): void => {
    core.accept({ level, msg, dims: o?.dims, meta: o?.meta }, dims)
  }
  return {
    log,
    debug: (msg, o) => log('debug', msg, o),
    info: (msg, o) => log('info', msg, o),
    warn: (msg, o) => log('warn', msg, o),
    error: (msg, o) => log('error', msg, o),
    fatal: (msg, o) => log('fatal', msg, o),
    child: (o) => wrap(core, core.mergeChildDims(dims, o?.dims), false),
    flush: () => core.flush(),
    close: owned ? () => core.close() : () => Promise.resolve(),
  }
}

export function createLogger(opts: LoggerOptions): Logger {
  return wrap(createCore(opts), {}, true)
}
