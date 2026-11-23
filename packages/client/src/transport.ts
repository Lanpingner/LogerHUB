import WebSocket from 'ws'
import { HELLO_DEFAULTS, type BatchFrame, type HelloFrame, type NackFrame, type ServerFrame } from '@logguber/shared'

export type TransportState = 'connecting' | 'open' | 'closed' | 'fatal'

export interface TransportOptions {
  url: string
  apiKey: string
  service: string
  env: string
  /** The gateway acknowledged this batch: it is durable and may leave the spool. */
  onAck: (id: string) => void
  /**
   * The batch was not delivered. `retryable` batches (gateway nack, ack timeout, connection
   * drop) should be re-spooled; non-retryable ones are the gateway's permanent rejection.
   */
  onNack: (f: NackFrame) => void
  onState: (s: TransportState) => void
  onError: (e: Error) => void
  /** Default 30000. */
  ackTimeoutMs?: number
  /** Reconnect delay is `min(maxMs, baseMs * 2 ** attempt)` with full jitter. Default 500 / 30000. */
  backoff?: { baseMs: number; maxMs: number }
  /** The gateway's announced limits, which override the client's configured ones. Called before state `open` is reported. */
  onHello?: (h: HelloFrame) => void
}

/** Internal test seams; not part of the public surface. */
export interface TransportHooks {
  /** Defaults to Math.random. */
  random?: () => number
  /** Observes each scheduled reconnect delay. */
  onBackoff?: (delayMs: number) => void
  /** Max wait for `hello` after the upgrade. Default 10000. */
  helloTimeoutMs?: number
  /** How long a connection must stay open before the backoff counter resets. Default 10000. */
  stableMs?: number
}

export interface Transport {
  /** False when the socket is not open or the ack window is full: the caller should spool. */
  send(b: BatchFrame): boolean
  /** Sent but not yet acked batches, so the caller can spool them before exit. */
  inFlightBatches(): BatchFrame[]
  inFlight(): number
  state(): TransportState
  /** Final teardown; idempotent. In-flight batches are not nacked: they stay unacked in the spool. */
  close(): Promise<void>
}

const FATAL_CODES = new Set([4401, 4403])
const DEFAULT_ACK_TIMEOUT_MS = 30_000
const DEFAULT_BACKOFF = { baseMs: 500, maxMs: 30_000 }
const HANDSHAKE_TIMEOUT_MS = 10_000
const DEFAULT_HELLO_TIMEOUT_MS = 10_000
const DEFAULT_STABLE_MS = 10_000
const AUTH_HTTP_STATUSES = new Set([401, 403])

/** Finite number >= 1 (floored), otherwise the fallback. */
function sane(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
}

export function createTransport(opts: TransportOptions): Transport {
  return buildTransport(opts, {})
}

export function buildTransport(opts: TransportOptions, hooks: TransportHooks): Transport {
  const ackTimeoutMs = opts.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS
  const backoff = opts.backoff ?? DEFAULT_BACKOFF
  const random = hooks.random ?? Math.random
  const helloTimeoutMs = hooks.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS
  const stableMs = hooks.stableMs ?? DEFAULT_STABLE_MS

  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; batch: BatchFrame }>()
  let state: TransportState = 'connecting'
  let ws: WebSocket | undefined
  let ackWindow: number = HELLO_DEFAULTS.ackWindow
  let attempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let finished = false // close() called or fatal reached: never connect again
  let closing: Promise<void> | undefined
  let helloTimer: ReturnType<typeof setTimeout> | undefined
  let stableTimer: ReturnType<typeof setTimeout> | undefined

  // Nothing here may throw into the application, including its own callbacks.
  function guard(fn: () => void): void {
    try { fn() } catch { /* swallow */ }
  }
  function report(e: unknown): void {
    guard(() => opts.onError(e instanceof Error ? e : new Error(String(e))))
  }
  function setState(s: TransportState): void {
    if (state === s) return
    state = s
    guard(() => opts.onState(s))
  }

  function releaseAll(reason: string): void {
    const ids = [...pending.keys()]
    for (const p of pending.values()) clearTimeout(p.timer)
    pending.clear()
    for (const id of ids) guard(() => opts.onNack({ t: 'nack', id, reason, retryable: true }))
  }

  function clearReconnect(): void {
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
    reconnectTimer = undefined
  }

  function clearConnTimers(): void {
    if (helloTimer !== undefined) clearTimeout(helloTimer)
    if (stableTimer !== undefined) clearTimeout(stableTimer)
    helloTimer = stableTimer = undefined
  }

  /** A condition no retry can fix: stop for good and say so. */
  function fatal(e: Error): void {
    finished = true
    clearReconnect()
    clearConnTimers()
    setState('fatal')
    report(e)
  }

  function connect(): void {
    if (finished) return
    setState('connecting')
    let sock: WebSocket
    try {
      // A malformed URL or a header-invalid key throws here and can never succeed later.
      const u = new URL(opts.url)
      u.searchParams.set('service', opts.service)
      u.searchParams.set('env', opts.env)
      sock = new WebSocket(u, {
        headers: { authorization: `Bearer ${opts.apiKey}` },
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      })
    } catch (e) {
      fatal(new Error(`invalid transport configuration: ${e instanceof Error ? e.message : String(e)}`))
      return
    }
    ws = sock
    let dropped = false // an error and a close for the same socket count once
    let refusedStatus: number | undefined // HTTP status when the upgrade itself was refused

    helloTimer = setTimeout(() => {
      helloTimer = undefined
      report(new Error('gateway did not send hello in time'))
      sock.terminate() // the close event routes through the normal transient path
    }, helloTimeoutMs)
    helloTimer.unref()

    sock.on('unexpected-response', (_req, res) => {
      refusedStatus = res.statusCode
      res.resume()
      report(new Error(`gateway refused the upgrade with HTTP ${res.statusCode}`))
      sock.terminate()
    })

    sock.on('message', (raw) => {
      if (ws === sock) onMessage(raw.toString())
    })
    sock.on('error', (e) => {
      // The close event that follows drives reconnection. Teardown noise is not an error.
      if (!finished && refusedStatus === undefined) report(e)
    })
    sock.on('close', (code) => {
      if (dropped) return
      dropped = true
      if (ws !== sock) return
      ws = undefined
      clearConnTimers()
      onDrop(code, refusedStatus !== undefined && AUTH_HTTP_STATUSES.has(refusedStatus))
    })
  }

  function onMessage(text: string): void {
    let frame: ServerFrame
    try {
      frame = JSON.parse(text) as ServerFrame
    } catch {
      report(new Error('gateway sent malformed JSON'))
      return
    }
    switch (frame?.t) {
      case 'hello':
        {
          const hello: HelloFrame = {
            t: 'hello',
            maxEntriesPerBatch: sane(frame.maxEntriesPerBatch, HELLO_DEFAULTS.maxEntriesPerBatch),
            maxBatchBytes: sane(frame.maxBatchBytes, HELLO_DEFAULTS.maxBatchBytes),
            ackWindow: sane(frame.ackWindow, HELLO_DEFAULTS.ackWindow),
          }
          ackWindow = hello.ackWindow
          if (helloTimer !== undefined) clearTimeout(helloTimer)
          helloTimer = undefined
          // Only a connection that stays up earns a fresh backoff; a flapping gateway keeps growing it.
          if (stableTimer !== undefined) clearTimeout(stableTimer)
          stableTimer = setTimeout(() => { stableTimer = undefined; attempt = 0 }, stableMs)
          stableTimer.unref()
          guard(() => opts.onHello?.(hello))
          setState('open')
        }
        break
      case 'ack':
        if (release(frame.id)) guard(() => opts.onAck(frame.id))
        break
      case 'nack':
        if (release(frame.id)) guard(() => opts.onNack(frame))
        break
      default:
        break // unknown frame types are ignored for forward compatibility
    }
  }

  function release(id: string): boolean {
    const p = pending.get(id)
    if (p === undefined) return false // never sent, already acked or already timed out
    clearTimeout(p.timer)
    pending.delete(id)
    return true
  }

  function onDrop(code: number, authRefused: boolean): void {
    releaseAll('connection closed')
    if (finished) return
    if (authRefused) {
      fatal(new Error('gateway refused the upgrade as unauthorized: check the API key and its permissions'))
      return
    }
    if (FATAL_CODES.has(code)) {
      fatal(new Error(`gateway closed the connection with ${code}: check the API key and its permissions`))
      return
    }
    setState('closed')
    scheduleReconnect()
  }

  function scheduleReconnect(): void {
    if (finished || reconnectTimer !== undefined) return
    const ceiling = Math.min(backoff.maxMs, backoff.baseMs * 2 ** attempt)
    attempt++
    const ms = random() * ceiling // full jitter: uniform in [0, ceiling)
    guard(() => hooks.onBackoff?.(ms))
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      connect()
    }, ms)
    reconnectTimer.unref()
  }

  connect()

  return {
    send(b) {
      if (state !== 'open' || !ws || ws.readyState !== WebSocket.OPEN) return false
      if (pending.size >= ackWindow || pending.has(b.id)) return false
      try {
        ws.send(JSON.stringify(b), (err) => { if (err) report(err) })
      } catch (e) {
        report(e)
        return false
      }
      const timer = setTimeout(() => {
        if (!pending.delete(b.id)) return
        guard(() => opts.onNack({ t: 'nack', id: b.id, reason: 'ack timeout', retryable: true }))
      }, ackTimeoutMs)
      timer.unref()
      pending.set(b.id, { timer, batch: b })
      return true
    },
    inFlightBatches: () => [...pending.values()].map((p) => p.batch),
    inFlight: () => pending.size,
    state: () => state,
    close() {
      if (closing) return closing
      finished = true
      clearReconnect()
      clearConnTimers()
      for (const p of pending.values()) clearTimeout(p.timer)
      pending.clear()
      const sock = ws
      ws = undefined
      if (state !== 'fatal') setState('closed')
      closing = new Promise<void>((resolve) => {
        if (!sock || sock.readyState === WebSocket.CLOSED) return resolve()
        sock.once('close', () => resolve())
        sock.on('error', () => {})
        sock.terminate()
      })
      return closing
    },
  }
}
