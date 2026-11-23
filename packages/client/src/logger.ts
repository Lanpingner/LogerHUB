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
import { createTransport, type TransportState } from './transport'
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
      for (const [k, t] of lastSeen) if (now - t >= ERROR_INTERVAL_MS) lastSeen.delete(k)
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
  count(): number
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
    count: () => spool.count(),
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
    count: () => queue.length + claimed.size,
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

/** Keeps string dimensions, stringifies the other primitives, drops everything else. */
function mergeDims(...sources: Array<Record<string, unknown> | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const source of sources) {
    if (source === null || typeof source !== 'object') continue
    for (const [k, v] of Object.entries(source)) {
      if (typeof v === 'string') out[k] = v
      else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v)
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
  flush(): Promise<void>
  close(): Promise<void>
}

/**
 * Wires batcher -> transport -> store. Shared by `createLogger` and `createSink`: a log call
 * enqueues, the batcher cuts, the transport sends, and whatever the gateway does not
 * acknowledge ends up in the store to be replayed oldest first.
 */
export function createCore(opts: LoggerOptions): LoggerCore {
  const report = createReporter(opts.onError)
  const baseDims = mergeDims(opts.dims)
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
  let draining = false
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

  const transport = createTransport({
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
  })

  function onBatch(entries: LogEntry[], droppedSinceLast: number): void {
    // The batcher counts dropped entries and resets on read; the store counts pruned batches
    // and never resets, so take its delta. Two units: reported side by side, never summed.
    const prunedDelta = Math.max(0, store.prunedCount() - reportedPruned)
    reportedPruned += prunedDelta
    const batch: BatchFrame = { t: 'batch', id: ulid(), entries }
    if (droppedSinceLast > 0) batch.droppedSinceLast = droppedSinceLast
    if (prunedDelta > 0) batch.prunedBatchesSinceLast = prunedDelta
    // `always` keeps a copy before the wire; otherwise the store is only for what cannot go now,
    // and a non-empty store takes precedence so replay stays oldest first.
    if (closed || mode === 'always' || store.count() > 0 || !transport.send(batch)) {
      store.push(batch)
      drain()
      return
    }
    sent.set(batch.id, { batch, fromStore: false })
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
    if (rec !== undefined && !rec.fromStore) store.push(rec.batch)
    else store.release(f.id)
    retryNotBefore = Date.now() + NACK_RETRY_DELAY_MS
    scheduleRetry()
  }

  /** One pending nudge, so a nacking gateway is retried on a timer rather than in a loop. */
  function scheduleRetry(): void {
    if (closed || retryTimer !== undefined) return
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      drain()
    }, NACK_RETRY_DELAY_MS)
    retryTimer.unref?.()
  }

  /** Sends stored batches oldest first, up to the free ack window. Event-driven: never a spin. */
  function drain(): void {
    if (closed || draining || transport.state() !== 'open' || Date.now() < retryNotBefore) return
    draining = true
    try {
      for (;;) {
        const free = ackWindow - transport.inFlight()
        if (free <= 0) return
        const claimed = store.claim(free)
        if (claimed.length === 0) return
        for (let i = 0; i < claimed.length; i++) {
          const batch = claimed[i]
          if (transport.send(batch)) {
            sent.set(batch.id, { batch, fromStore: true })
            continue
          }
          // The window closed under us: hand back every claim we cannot honour, or they
          // would sit unclaimable until the claim expires.
          for (let j = i; j < claimed.length; j++) store.release(claimed[j].id)
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
    while (store.count() > 0 || transport.inFlight() > 0) {
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
  function storeInFlight(): void {
    for (const batch of transport.inFlightBatches()) {
      const rec = sent.get(batch.id)
      if (rec?.fromStore === true) continue
      store.push(batch)
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
    storeInFlight() // before close(), which forgets the transport's pending batches
    await transport.close()
    store.close()
  }

  return {
    accept(raw, dims) {
      const entry: LogEntry = {
        ts: timestamp(raw.ts),
        level: isLevel(raw.level) ? raw.level : 'info',
        msg: typeof raw.msg === 'string' ? raw.msg : String(raw.msg ?? ''),
      }
      if (raw.kind === 'request') entry.kind = 'request'
      const merged = mergeDims(baseDims, dims, raw.dims)
      if (Object.keys(merged).length > 0) entry.dims = merged
      if (raw.meta !== undefined) {
        // Redaction and truncation happen here, before the queue, so no secret ever reaches
        // the network or the disk.
        const meta = truncateJson(redactBody(raw.meta, { redactKeys: opts.redactKeys }))
        if (meta !== undefined) entry.meta = asRecord(meta)
      }
      batcher.push(entry)
    },

    async flush() {
      if (closing !== undefined) {
        await closing
        return
      }
      batcher.flush()
      drain()
      await settle(FLUSH_TIMEOUT_MS)
      storeInFlight()
    },

    close() {
      if (closing === undefined) closing = shutdown()
      return closing
    },
  }
}

/** `owned` is false for a child: it shares the pipeline and must not be able to close it. */
function wrap(core: LoggerCore, dims: Record<string, string>, owned: boolean): Logger {
  const log = (level: string, msg: string, o?: LogOptions): void => {
    core.accept({ level, msg, meta: o?.meta }, o?.dims === undefined ? dims : mergeDims(dims, o.dims))
  }
  return {
    log,
    debug: (msg, o) => log('debug', msg, o),
    info: (msg, o) => log('info', msg, o),
    warn: (msg, o) => log('warn', msg, o),
    error: (msg, o) => log('error', msg, o),
    fatal: (msg, o) => log('fatal', msg, o),
    child: (o) => wrap(core, mergeDims(dims, o?.dims), false),
    flush: () => core.flush(),
    close: owned ? () => core.close() : () => Promise.resolve(),
  }
}

export function createLogger(opts: LoggerOptions): Logger {
  return wrap(createCore(opts), {}, true)
}
