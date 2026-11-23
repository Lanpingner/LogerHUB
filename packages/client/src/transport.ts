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

export function createTransport(opts: TransportOptions): Transport {
  return buildTransport(opts, {})
}

export function buildTransport(opts: TransportOptions, hooks: TransportHooks): Transport {
  const ackTimeoutMs = opts.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS
  const backoff = opts.backoff ?? DEFAULT_BACKOFF
  const random = hooks.random ?? Math.random

  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; batch: BatchFrame }>()
  let state: TransportState = 'connecting'
  let ws: WebSocket | undefined
  let ackWindow: number = HELLO_DEFAULTS.ackWindow
  let attempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let finished = false // close() called or fatal reached: never connect again
  let closing: Promise<void> | undefined

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

  function connect(): void {
    if (finished) return
    setState('connecting')
    const u = new URL(opts.url)
    u.searchParams.set('service', opts.service)
    u.searchParams.set('env', opts.env)
    let sock: WebSocket
    try {
      sock = new WebSocket(u, {
        headers: { authorization: `Bearer ${opts.apiKey}` },
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      })
    } catch (e) {
      report(e)
      scheduleReconnect()
      return
    }
    ws = sock
    let dropped = false // an error and a close for the same socket count once

    sock.on('message', (raw) => {
      if (ws === sock) onMessage(raw.toString())
    })
    sock.on('error', (e) => report(e)) // the close event that follows drives reconnection
    sock.on('close', (code) => {
      if (dropped) return
      dropped = true
      if (ws !== sock) return
      ws = undefined
      onDrop(code)
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
        if (Number.isInteger(frame.ackWindow) && frame.ackWindow >= 1) ackWindow = frame.ackWindow
        attempt = 0
        guard(() => opts.onHello?.(frame))
        setState('open')
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

  function onDrop(code: number): void {
    releaseAll('connection closed')
    if (finished) return
    if (FATAL_CODES.has(code)) {
      finished = true
      clearReconnect()
      setState('fatal')
      report(new Error(`gateway closed the connection with ${code}: check the API key and its permissions`))
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
