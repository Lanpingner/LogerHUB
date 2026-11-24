import type { IncomingMessage } from 'node:http'
import { randomBytes } from 'node:crypto'
import { redactBody, truncateJson } from './redact'
import type { ConsoleView } from './console'
import type { Logger, WebSocketLike, WebSocketServerLike, WsOptions } from './types'

const DEFAULT_MAX_PAYLOAD_BYTES = 2048

function shortId(): string {
  try {
    return randomBytes(4).toString('hex')
  } catch {
    return Math.random().toString(16).slice(2, 10)
  }
}

/** Same right-to-left rule as the HTTP middleware: only the entries our own proxies
 *  wrote can be trusted, and those are at the end. */
function callerIp(req: IncomingMessage, hops: number): string | undefined {
  const direct = req.socket?.remoteAddress
  if (hops <= 0) return direct ?? undefined
  const raw = req.headers['x-forwarded-for']
  const chain = (Array.isArray(raw) ? raw.join(',') : (raw ?? ''))
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  if (chain.length === 0) return direct ?? undefined
  const idx = chain.length - hops
  return (idx >= 0 ? chain[idx] : chain[0]) ?? direct ?? undefined
}

/** Byte length of whatever `ws` handed us, without copying it. */
function sizeOf(data: unknown): number {
  if (typeof data === 'string') return Buffer.byteLength(data)
  if (ArrayBuffer.isView(data)) return data.byteLength
  if (data instanceof ArrayBuffer) return data.byteLength
  if (Array.isArray(data)) return data.reduce<number>((n, part) => n + sizeOf(part), 0)
  return 0
}

/**
 * A payload is captured only when it parses as JSON, for the same reason the HTTP
 * middleware only captures JSON bodies: anything else cannot be redacted by key, and
 * a binary frame logged verbatim is both unreadable and a disclosure risk.
 */
function payloadOf(data: unknown, maxBytes: number): unknown {
  let text: string
  if (typeof data === 'string') text = data
  else if (ArrayBuffer.isView(data)) text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8')
  else return undefined
  if (Buffer.byteLength(text) > maxBytes) return { _truncated: true, _bytes: Buffer.byteLength(text) }
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') return undefined
    return truncateJson(redactBody(parsed), maxBytes)
  } catch {
    return undefined
  }
}

/**
 * One entry per connection, close and error, and optionally per message. Modelled on the
 * HTTP middleware: nothing here may break the socket, so every foreign call is guarded and
 * the application's own listeners are never replaced — we only add our own.
 *
 * Returns a function that removes the `connection` listener. Sockets already open keep
 * their listeners, because removing them mid-connection would lose the close entry that
 * balances the open one.
 */
export function createWsInstrumentation(
  logger: Logger,
  server: WebSocketServerLike,
  opts: WsOptions = {},
  view?: ConsoleView,
): () => void {
  const messages = opts.messages ?? 'none'
  const maxBytes =
    typeof opts.maxPayloadBytes === 'number' && opts.maxPayloadBytes >= 1
      ? Math.floor(opts.maxPayloadBytes)
      : DEFAULT_MAX_PAYLOAD_BYTES

  const onConnection = (socket: WebSocketLike, req: IncomingMessage): void => {
    try {
      attach(socket, req)
    } catch {
      // A connection must survive our failure to log it.
    }
  }

  server.on('connection', onConnection)
  return () => {
    try {
      server.off?.('connection', onConnection)
    } catch {
      // Nothing to undo if the server is already gone.
    }
  }

  function attach(socket: WebSocketLike, req: IncomingMessage): void {
    try {
      if (opts.ignore?.(req) === true) return
    } catch {
      // A throwing predicate means "not ignored": an unlogged connection is worse.
    }

    const id = resolveId(req)
    const path = (req.url ?? '').split('?')[0]
    const ip = opts.captureIp === true ? callerIp(req, opts.trustProxyHops ?? 0) : undefined
    const dims = resolveDims(req)
    const openedAt = Date.now()
    let sent = 0
    let received = 0
    let closed = false

    const base = (event: string): Record<string, unknown> => {
      const ws: Record<string, unknown> = { event, connection_id: id, path }
      if (ip !== undefined) ws.ip = ip
      return ws
    }

    if (opts.pending === true && view !== undefined) {
      try {
        view.pendingAdd({ id, method: 'WS', url: path, ip, startedAt: openedAt })
      } catch {
        // Only costs the in-flight line.
      }
    }

    logger.log('info', `WS open ${path}`, { dims, meta: { ws: base('open') } })

    socket.on('message', ((data: unknown, isBinary: unknown) => {
      try {
        received++
        if (messages === 'none') return
        const ws = base('message')
        ws.direction = 'in'
        ws.bytes = sizeOf(data)
        ws.binary = isBinary === true
        if (messages === 'payload' && isBinary !== true) {
          const payload = payloadOf(data, maxBytes)
          if (payload !== undefined) ws.payload = payload
        }
        logger.log('debug', `WS message ${path}`, { dims, meta: { ws } })
      } catch {
        // Never break the application's own message handler.
      }
    }) as (...args: never[]) => void)

    socket.on('close', ((code: unknown, reason: unknown) => {
      try {
        if (closed) return
        closed = true
        if (opts.pending === true && view !== undefined) {
          try {
            view.pendingRemove(id)
          } catch {
            // Leaves a stale in-flight line at worst.
          }
        }
        const ws = base('close')
        ws.duration_ms = Date.now() - openedAt
        ws.code = typeof code === 'number' ? code : undefined
        const text = reasonText(reason)
        if (text !== undefined) ws.reason = text
        ws.messages_in = received
        ws.messages_out = sent
        logger.log('info', `WS close ${path}`, { dims, meta: { ws } })
      } catch {
        // Nothing left to protect; the socket is gone.
      }
    }) as (...args: never[]) => void)

    socket.on('error', ((err: unknown) => {
      try {
        const ws = base('error')
        ws.duration_ms = Date.now() - openedAt
        logger.log('error', `WS error ${path}`, {
          dims,
          meta: { ws, error: err instanceof Error ? (err.stack ?? err.message) : String(err) },
        })
      } catch {
        // An error while logging an error stops here.
      }
    }) as (...args: never[]) => void)

    // Outbound frames are counted by wrapping `send`, the only way to see them: `ws`
    // emits no event for a message the server sends. The original is always called,
    // and a failure to count never stops the send.
    if (messages !== 'none' && typeof socket.send === 'function') {
      const original = socket.send as (...a: unknown[]) => unknown
      ;(socket as { send: unknown }).send = function (this: unknown, ...args: unknown[]) {
        try {
          sent++
          const ws = base('message')
          ws.direction = 'out'
          ws.bytes = sizeOf(args[0])
          if (messages === 'payload') {
            const payload = payloadOf(args[0], maxBytes)
            if (payload !== undefined) ws.payload = payload
          }
          logger.log('debug', `WS message ${path}`, { dims, meta: { ws } })
        } catch {
          // Counting is best effort; the frame still goes out.
        }
        return original.apply(this, args)
      }
    }
  }

  function resolveId(req: IncomingMessage): string {
    try {
      const v = opts.connectionId?.(req)
      if (typeof v === 'string' && v !== '') return v.slice(0, 128)
    } catch {
      // Fall through to a generated id.
    }
    return shortId()
  }

  function resolveDims(req: IncomingMessage): Record<string, string> | undefined {
    if (opts.resolveDims === undefined) return undefined
    try {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(opts.resolveDims(req) ?? {})) if (typeof v === 'string') out[k] = v
      return out
    } catch {
      return undefined // costs the dimensions, not the entry
    }
  }
}

function reasonText(reason: unknown): string | undefined {
  if (typeof reason === 'string') return reason === '' ? undefined : reason
  if (Buffer.isBuffer(reason)) {
    const s = reason.toString('utf8')
    return s === '' ? undefined : s
  }
  return undefined
}
