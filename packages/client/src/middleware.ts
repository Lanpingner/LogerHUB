import type { ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { redactBody, redactHeaders, truncateJson } from './redact'
import { ulid } from './ulid'
import type { ConsoleView } from './console'
import type { ExpressMiddleware, Logger, MiddlewareOptions, RequestLike } from './types'

const DEFAULT_MAX_BODY_BYTES = 8192
const MAX_REQUEST_ID_LENGTH = 128
/** Reported when the client went away before a status was sent (the nginx convention). */
const CLIENT_CLOSED = 499
/** Internal: `logger.expressMiddleware` passes the logger's header allowlist through. */
type Options = MiddlewareOptions & { headerAllowlist?: string[] }

/** 8 hex characters: short enough to read off a terminal, wide enough not to collide
 *  within one request's lifetime. Matches the local logger this replaces. */
function shortId(): string {
  try {
    return randomBytes(4).toString('hex')
  } catch {
    return ulid().slice(-8).toLowerCase()
  }
}

/**
 * The caller's address, honouring a fixed number of trusted proxy hops. Counting from the
 * right is the only safe direction: a client can append to `x-forwarded-for`, so the
 * rightmost entries are the ones our own proxies wrote.
 */
function callerIp(req: RequestLike, hops: number): string | undefined {
  const direct = req.socket?.remoteAddress
  if (hops <= 0) return direct ?? undefined
  const raw = req.headers['x-forwarded-for']
  const chain = (Array.isArray(raw) ? raw.join(',') : (raw ?? ''))
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  if (chain.length === 0) return direct ?? undefined
  // One hop means "the last entry is our proxy's view of the client".
  const idx = chain.length - hops
  return (idx >= 0 ? chain[idx] : chain[0]) ?? direct ?? undefined
}

/** The one rule for "should this exchange's bodies be captured": errors, plus whatever the mode adds. */
function capturesBodies(mode: string, status: number, sampled: boolean): boolean {
  return mode === 'always' || (mode !== 'never' && (status >= 400 || sampled))
}

const isJsonish = (contentType: unknown): boolean =>
  typeof contentType === 'string' && /^\s*[\w.-]+\/([\w.-]+\+)?json\b/i.test(contentType)

function levelFor(status: number): 'error' | 'warn' | 'info' {
  return status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'
}

/**
 * The matched route pattern, never the raw path: a pattern keeps the cardinality of per-route
 * usage counts bounded. `unmatched` covers a 404 and anything that failed before routing.
 */
function routeOf(req: RequestLike): string {
  const p = req.route?.path
  if (p === undefined) return 'unmatched'
  return `${req.baseUrl ?? ''}${typeof p === 'string' ? p : String(p)}`
}

/**
 * An empty object or array says nothing, and reads as "an empty body was sent". Express 4's
 * json parser leaves `req.body = {}` for a request it did not parse where Express 5 leaves it
 * undefined; dropping empties here is a deliberate normalisation of that upstream difference,
 * so the same field exists, or not, on both. Do not "fix" it back.
 */
function nonEmpty(v: unknown): unknown {
  if (Array.isArray(v)) return v.length > 0 ? v : undefined
  if (v !== null && typeof v === 'object') return Object.keys(v).length > 0 ? v : undefined
  return v
}

/** Only parsed objects and arrays: a Buffer, stream or free-form string cannot be redacted by key. */
function requestBody(req: RequestLike, maxBytes: number, allowFields?: string[]): unknown {
  const b = req.body
  if (b === null || typeof b !== 'object' || Buffer.isBuffer(b) || ArrayBuffer.isView(b)) return undefined
  // No `redactKeys` here on purpose: the logger redacts all of `meta` again, with the custom
  // keys, in `accept` (logger.ts). Custom keys reach request bodies only through that pass.
  return nonEmpty(truncateJson(redactBody(b, { allowFields }), maxBytes))
}

/**
 * One `kind: 'request'` entry per request, emitted when the response finishes, or when the
 * connection closes without finishing, so an aborted request is still counted. Nothing in here
 * may break the request: every foreign call is guarded and the original `write`/`end` always run.
 */
export function createExpressMiddleware(
  logger: Logger,
  opts: Options = {},
  view?: ConsoleView,
): ExpressMiddleware {
  const mode = opts.bodies ?? 'on-error'
  const maxBytes =
    typeof opts.maxBodyBytes === 'number' && opts.maxBodyBytes >= 1 ? Math.floor(opts.maxBodyBytes) : DEFAULT_MAX_BODY_BYTES
  const rate = typeof opts.sampleRate === 'number' && Number.isFinite(opts.sampleRate) ? opts.sampleRate : 0

  return (req, res, next) => {
    try {
      track(req, res)
    } catch {
      // Never cost the request its handler.
    }
    next()
  }

  function track(req: RequestLike, res: ServerResponse): void {
    try {
      if (opts.ignore?.(req) === true) return
    } catch {
      // A throwing predicate means "not ignored": an uncounted request is the worse error.
    }
    const start = process.hrtime.bigint()
    const startedAt = Date.now()
    const sampled = mode === 'sample' && Math.random() < rate
    // Independent of body capture: `bodies: 'never'` must not cost the timing split.
    const firstByte = markFirstByte(res)
    const body = mode === 'never' ? undefined : captureResponse(res, mode, sampled, maxBytes)
    let emitted = false

    // The id is settled on entry, not on finish: the in-flight line must carry the
    // same id the finished line will.
    const supplied = (() => {
      try {
        const v = opts.requestId?.(req)
        return typeof v === 'string' && v !== '' ? v.slice(0, MAX_REQUEST_ID_LENGTH) : undefined
      } catch {
        return undefined
      }
    })()
    const header = req.headers['x-request-id']
    const requestId =
      supplied ??
      (typeof header === 'string' && header !== '' ? header.slice(0, MAX_REQUEST_ID_LENGTH) : shortId())
    const ip = opts.captureIp === true ? callerIp(req, opts.trustProxyHops ?? 0) : undefined

    if (opts.pending === true && view !== undefined) {
      try {
        view.pendingAdd({
          id: requestId,
          method: req.method ?? '',
          url: (req.originalUrl ?? req.url ?? '').split('?')[0],
          ip,
          startedAt,
        })
      } catch {
        // A terminal that will not redraw must not cost the request.
      }
    }

    const emit = (finished: boolean): void => {
      if (emitted) return
      emitted = true
      const finishAt = process.hrtime.bigint()
      if (opts.pending === true && view !== undefined) {
        try {
          view.pendingRemove(requestId)
        } catch {
          // Leaves a stale in-flight line at worst.
        }
      }
      try {
        const status = finished || res.headersSent ? res.statusCode : CLIENT_CLOSED
        const route = routeOf(req)
        const http: Record<string, unknown> = {
          method: req.method,
          route,
          path: (req.originalUrl ?? req.url ?? '').split('?')[0],
          status,
          duration_ms: Number(finishAt - start) / 1e6,
          request_id: requestId,
          req: { headers: redactHeaders(req.headers, opts.headerAllowlist) },
          res: {},
        }
        // Scalars on `http`, not entries of `http.timings`: that map is rendered as one flat
        // waterfall normalised by its sum, and server_ms contains any phase reported inside it.
        // Omitted together when no byte went out; the `aborted` flag already says why.
        const firstByteAt = firstByte.at()
        if (firstByteAt !== undefined) {
          http.server_ms = Number(firstByteAt - start) / 1e6
          http.transit_ms = Number(finishAt - firstByteAt) / 1e6
        }
        if (ip !== undefined) http.ip = ip
        if (!finished) http.aborted = true
        // Application facts last, but they cannot overwrite the measured ones: a
        // resolveMeta that returns `status` must not be able to rewrite the status
        // the usage counts are derived from.
        for (const [k, v] of Object.entries(resolveExtra(req, res))) {
          if (!Object.hasOwn(http, k)) http[k] = v
        }
        const note = resolveNote(req, res)
        if (note !== undefined && !Object.hasOwn(http, 'note')) http.note = note
        if (capturesBodies(mode, status, sampled)) {
          // Its own guard: a body that cannot be read costs the bodies, never the line the
          // usage counts are derived from.
          try {
            const reqBody = requestBody(req, maxBytes, opts.allowFields)
            if (reqBody !== undefined) (http.req as Record<string, unknown>).body = reqBody
            const resBody = body?.result(opts.allowFields)
            if (resBody !== undefined) (http.res as Record<string, unknown>).body = resBody
          } catch {
            // Headers and timing still go out. The flag makes the gap visible: one body may
            // have been captured and the other not, and the line would otherwise look complete.
            http.body_capture_failed = true
          }
        }
        logger.log(levelFor(status), `${req.method} ${route} ${status}`, {
          kind: 'request',
          dims: resolveDims(req),
          meta: { http },
        })
      } catch {
        // Logging is best effort; the response is already on its way.
      }
    }
    res.once('finish', () => emit(true))
    res.once('close', () => emit(false))
  }

  function resolveExtra(req: RequestLike, res: ServerResponse): Record<string, unknown> {
    if (opts.resolveMeta === undefined) return {}
    try {
      const out = opts.resolveMeta(req, res)
      if (out === null || typeof out !== 'object') return {}
      // Undefined values are dropped rather than written: `app: undefined` should read
      // as "no app", not as a key whose value is missing.
      const kept: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(out)) if (v !== undefined) kept[k] = v
      return kept
    } catch {
      return {} // costs the extra fields, not the entry
    }
  }

  function resolveNote(req: RequestLike, res: ServerResponse): string | undefined {
    if (opts.note === undefined) return undefined
    try {
      const v = opts.note(req, res)
      return typeof v === 'string' && v !== '' ? v : undefined
    } catch {
      return undefined
    }
  }

  function resolveDims(req: RequestLike): Record<string, string> | undefined {
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

/**
 * Records when the response first reaches the wire: the earliest of `writeHead`, `write` and
 * `end`. `writeHead` counts because a headers-only response (204, HEAD) may never write a body.
 * Set once and never overwritten, so a second `end()` or an error handler that answers after the
 * route began cannot move the mark later and shrink the server time.
 */
function markFirstByte(res: ServerResponse): { at(): bigint | undefined } {
  let firstByteAt: bigint | undefined
  const mark = (): void => {
    try {
      firstByteAt ??= process.hrtime.bigint()
    } catch {
      // Timing is best effort; the response must go out regardless.
    }
  }
  for (const name of ['writeHead', 'write', 'end'] as const) {
    const original = res[name] as (...a: unknown[]) => unknown
    res[name] = function (this: ServerResponse, ...args: unknown[]) {
      mark()
      return original.apply(this, args)
    } as never
  }
  return { at: () => firstByteAt }
}

interface ResponseCapture {
  /** The parsed, redacted, size-bounded body, or undefined when nothing was (or could be) captured. */
  result(allowFields?: string[]): unknown
}

/**
 * Wraps `res.write`/`res.end` to copy what passes through. Whether to copy is decided once, at
 * the first chunk, when the status and content type are known: only a JSON-ish, unencoded
 * response the mode asks for is buffered. A stream (`text/event-stream`), multipart or any
 * other type is never touched, and buffering stops for good once `maxBytes` is exceeded.
 */
function captureResponse(res: ServerResponse, mode: string, sampled: boolean, maxBytes: number): ResponseCapture {
  const chunks: Buffer[] = []
  let size = 0
  let overflow = false
  /** Every byte seen, including past the cap, so the truncation marker can say how big the body was. */
  let total = 0
  let decision: 'capture' | 'skip' | undefined
  let ended = false

  const wanted = (): boolean => {
    // Load-bearing even though compressed bytes would fail to parse: without this skip every
    // compressed response would be buffered up to the cap and large ones stamped `_truncated`.
    const encoding = res.getHeader('content-encoding')
    const encoded = encoding !== undefined && String(encoding).toLowerCase() !== 'identity'
    return capturesBodies(mode, res.statusCode, sampled) && !encoded && isJsonish(res.getHeader('content-type'))
  }

  const take = (chunk: unknown, encoding: unknown): void => {
    if (ended || decision === 'skip') return
    decision ??= wanted() ? 'capture' : 'skip'
    if (decision === 'skip') return
    const view = ArrayBuffer.isView(chunk) ? chunk : undefined
    if (typeof chunk !== 'string' && view === undefined) return
    const enc = typeof encoding === 'string' && Buffer.isEncoding(encoding) ? encoding : 'utf8'
    // Measure before copying: a large payload over the budget is never duplicated.
    const len = typeof chunk === 'string' ? Buffer.byteLength(chunk, enc) : view!.byteLength
    total += len
    if (overflow) return
    if (size + len > maxBytes) {
      overflow = true
      chunks.length = 0
      return
    }
    size += len
    // Copies: the application may reuse or pool the buffer it just wrote.
    chunks.push(
      typeof chunk === 'string' ? Buffer.from(chunk, enc) : Buffer.from(Buffer.from(view!.buffer, view!.byteOffset, len)),
    )
  }

  const write = res.write
  const end = res.end
  const guarded = (args: unknown[]): void => {
    try {
      take(args[0], args[1])
    } catch {
      // Capture is best effort; the response must go out regardless.
    }
  }
  res.write = function (this: ServerResponse, ...args: unknown[]) {
    guarded(args)
    return (write as (...a: unknown[]) => boolean).apply(this, args)
  } as typeof res.write
  res.end = function (this: ServerResponse, ...args: unknown[]) {
    guarded(args)
    ended = true
    return (end as (...a: unknown[]) => ServerResponse).apply(this, args)
  } as typeof res.end

  return {
    result(allowFields) {
      // `_bytes` here is raw bytes on the wire; truncateJson's is the serialised redacted value.
      if (overflow) return { _truncated: true, _bytes: total }
      if (decision !== 'capture' || chunks.length === 0) return undefined
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        return nonEmpty(truncateJson(redactBody(parsed, { allowFields }), maxBytes))
      } catch {
        return undefined
      }
    },
  }
}
