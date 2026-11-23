import type { ServerResponse } from 'node:http'
import { redactBody, redactHeaders, truncateJson } from './redact'
import { ulid } from './ulid'
import type { ExpressMiddleware, Logger, MiddlewareOptions, RequestLike } from './types'

const DEFAULT_MAX_BODY_BYTES = 8192
const MAX_REQUEST_ID_LENGTH = 128
/** Reported when the client went away before a status was sent (the nginx convention). */
const CLIENT_CLOSED = 499
/** Internal: `logger.expressMiddleware` passes the logger's header allowlist through. */
type Options = MiddlewareOptions & { headerAllowlist?: string[] }

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
  return nonEmpty(truncateJson(redactBody(b, { allowFields }), maxBytes))
}

/**
 * One `kind: 'request'` entry per request, emitted when the response finishes, or when the
 * connection closes without finishing, so an aborted request is still counted. Nothing in here
 * may break the request: every foreign call is guarded and the original `write`/`end` always run.
 */
export function createExpressMiddleware(logger: Logger, opts: Options = {}): ExpressMiddleware {
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
    const sampled = mode === 'sample' && Math.random() < rate
    const body = mode === 'never' ? undefined : captureResponse(res, mode, sampled, maxBytes)
    let emitted = false

    const emit = (finished: boolean): void => {
      if (emitted) return
      emitted = true
      try {
        const status = finished || res.headersSent ? res.statusCode : CLIENT_CLOSED
        const route = routeOf(req)
        const rid = req.headers['x-request-id']
        const http: Record<string, unknown> = {
          method: req.method,
          route,
          path: (req.originalUrl ?? req.url ?? '').split('?')[0],
          status,
          duration_ms: Number(process.hrtime.bigint() - start) / 1e6,
          request_id: typeof rid === 'string' && rid !== '' ? rid.slice(0, MAX_REQUEST_ID_LENGTH) : ulid(),
          req: { headers: redactHeaders(req.headers, opts.headerAllowlist) },
          res: {},
        }
        if (!finished) http.aborted = true
        if (capturesBodies(mode, status, sampled)) {
          const reqBody = requestBody(req, maxBytes, opts.allowFields)
          if (reqBody !== undefined) (http.req as Record<string, unknown>).body = reqBody
          const resBody = body?.result(opts.allowFields)
          if (resBody !== undefined) (http.res as Record<string, unknown>).body = resBody
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
  let decision: 'capture' | 'skip' | undefined
  let ended = false

  const wanted = (): boolean => {
    const encoding = res.getHeader('content-encoding')
    const encoded = encoding !== undefined && String(encoding).toLowerCase() !== 'identity'
    return capturesBodies(mode, res.statusCode, sampled) && !encoded && isJsonish(res.getHeader('content-type'))
  }

  const take = (chunk: unknown, encoding: unknown): void => {
    if (ended || overflow || decision === 'skip') return
    decision ??= wanted() ? 'capture' : 'skip'
    if (decision === 'skip') return
    let buf: Buffer
    if (typeof chunk === 'string') {
      buf = Buffer.from(chunk, typeof encoding === 'string' && Buffer.isEncoding(encoding) ? encoding : 'utf8')
    } else if (ArrayBuffer.isView(chunk)) {
      buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    } else return
    if (size + buf.length > maxBytes) {
      overflow = true
      chunks.length = 0
      return
    }
    size += buf.length
    chunks.push(buf)
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
      if (overflow) return { _truncated: true }
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
