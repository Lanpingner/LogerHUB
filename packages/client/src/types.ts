/** Client-facing option types only. Wire types live in `@logguber/shared`. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LogEntry } from '@logguber/shared'

export interface RedactOptions {
  /** Keys whose values are replaced with `[redacted]`, matched case-insensitively at any depth. */
  redactKeys?: string[]
  /** When set, only these top-level fields are captured; everything else is dropped. */
  allowFields?: string[]
}

/** Where a batch that could not be delivered is kept until it can be. */
export interface SpoolConfig {
  dir: string
  /** `on-failure` (default) touches the disk only while the stream is down; `always` writes every batch first. */
  mode?: 'on-failure' | 'always'
  maxBytes?: number
  maxAge?: number
}

export interface BatchConfig {
  /** Entries per batch. Default 100, lowered by the gateway's `hello`. */
  maxEntries?: number
  /** Milliseconds before a partial batch is cut. Default 1000. */
  maxMs?: number
  /** Entries held in memory before the oldest are dropped. Default 10000. */
  maxQueue?: number
}

/** Local terminal output, so one call both prints and streams.
 *  Off by default: a logging library should not write to your stdout uninvited. */
export interface ConsoleConfig {
  enabled?: boolean
  /** Minimum level to print locally. The gateway still receives everything. */
  level?: 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  /** Defaults to whether stdout is a TTY. `NO_COLOR` always wins. */
  color?: boolean
  /** Prefix on non-request lines. Defaults to the entry script's filename, then the service. */
  label?: string
  /** Redraw in-flight requests at the bottom of the terminal. TTY only. */
  pending?: boolean
  /** Also append the uncoloured line here. Optional: the gateway is the durable copy. */
  file?: string
  /** Letters drawn in the auth tag, in order. Default `['A', 'P', 'R']`. */
  authTagLetters?: string[]
  /** Letters always drawn as "ran, uncached" — a check that is never served from a cache. Default `['R']`. */
  authTagAlways?: string[]
  /** Test seam. */
  stream?: NodeJS.WriteStream
}

export interface LoggerOptions {
  url: string
  apiKey: string
  service: string
  env: string
  spool?: SpoolConfig
  batch?: BatchConfig
  /** Reconnect delay is `min(maxMs, baseMs * 2 ** attempt)` with full jitter. Default 500 / 30000. */
  backoff?: { baseMs: number; maxMs: number }
  /** Dimensions stamped on every entry. */
  dims?: Record<string, string>
  /** Extends the default redacted body keys; it never replaces them. */
  redactKeys?: string[]
  /** Replaces the default request-header allowlist. */
  headerAllowlist?: string[]
  /** Prints every entry locally as well as streaming it. Off unless enabled. */
  console?: ConsoleConfig
  /** Every internal failure, rate-limited per cause. Defaults to one `console.warn` per interval. */
  onError?: (e: Error) => void
}

export interface LogOptions {
  dims?: Record<string, string>
  meta?: Record<string, unknown>
  /**
   * Marks the entry as a request record. Set by the Express middleware; honoured by `log()`
   * only, so the level methods never produce it. `log()` honours it from any caller by design
   * (a pino/winston adapter needs it), so usage counts derived from `kind: 'request'` trust the
   * application not to forge one.
   */
  kind?: 'request'
}

/** The parts of an Express request the middleware reads, declared here so the package needs no Express types. */
export interface RequestLike extends IncomingMessage {
  path?: string
  originalUrl?: string
  baseUrl?: string
  route?: { path?: unknown }
  body?: unknown
}

export type BodyCapture = 'never' | 'on-error' | 'sample' | 'always'

export interface MiddlewareOptions {
  /** Dimensions for the entry, read when the response finishes (so `req.user` is populated). */
  resolveDims?: (req: RequestLike) => Record<string, string | undefined>
  /** Return true to skip a request entirely. Evaluated on entry. */
  ignore?: (req: RequestLike) => boolean
  /**
   * `on-error` (default) captures bodies of responses with status >= 400; `sample` captures
   * those plus `sampleRate` of the rest; `always` captures everything; `never` nothing.
   */
  bodies?: BodyCapture
  /** Fraction (0..1) of successful requests captured under `sample`. Default 0. */
  sampleRate?: number
  /** Captured bodies larger than this are replaced by a truncation marker. Default 8192. */
  maxBodyBytes?: number
  /** When set, only these top-level body fields are captured. */
  allowFields?: string[]
  /**
   * Extra fields for `meta.http`, read when the response finishes. This is where
   * application facts that are not dimensions belong: which auth path ran, whether
   * it was cached, why a request was refused.
   *
   * Four keys are reserved, and the console renders them on the request line:
   * - `auth: { type, cached }` draws the auth tag, dimming the letters that did not run
   * - `tags: { app: 'x' }`     appends ` app:x`
   * - `flags: ['ip-exc']`      appends ` ip-exc`
   * - `note: 'why'`            appends ` (why)`
   * They are ordinary metadata too, so the gateway stores and can search them.
   */
  resolveMeta?: (req: RequestLike, res: ServerResponse) => Record<string, unknown> | undefined
  /** Reuse an id your application already assigned, instead of generating one. */
  requestId?: (req: RequestLike) => string | undefined
  /** Capture the caller's address. Off by default: an IP is personal data. */
  captureIp?: boolean
  /** Trusted proxy hops when reading `x-forwarded-for` for `captureIp`. Default 0. */
  trustProxyHops?: number
  /** Show this request in the terminal's in-flight block while it runs. */
  pending?: boolean
  /** A short note appended to the console line, such as a refusal reason. */
  note?: (req: RequestLike, res: ServerResponse) => string | undefined
}

export type ExpressMiddleware = (req: RequestLike, res: ServerResponse, next: (err?: unknown) => void) => void

/**
 * Accepts the shape a local console logger has: `info('a', err, { n: 1 })` joins its
 * arguments into one message, Errors as their stack. A trailing object whose only keys
 * are `dims`, `meta` and/or `kind` is read as options instead of as a message part.
 */
export type LogMethod = (msg: unknown, ...rest: unknown[]) => void

/** What `meta.http.auth` must look like for the console to draw the auth tag. */
export interface AuthTag {
  /** Which check ran. Any single letter; the console dims the letters that did not run. */
  type?: string
  /** Served from a cache rather than the database. Drawn in a different colour. */
  cached?: boolean
}

export interface Logger {
  /** Any string is accepted; an unknown level is recorded as `info`. */
  log(level: string, msg: unknown, ...rest: unknown[]): void
  debug: LogMethod
  info: LogMethod
  warn: LogMethod
  error: LogMethod
  fatal: LogMethod
  /** A logger over the same stream with extra dimensions. It owns nothing: closing it is a no-op. */
  child(opts?: { dims?: Record<string, string> }): Logger
  /** Cuts a batch and waits, briefly, for the gateway to acknowledge everything outstanding. */
  flush(): Promise<void>
  /** One `kind: 'request'` entry per HTTP request. Mount with `app.use(log.expressMiddleware())`. */
  expressMiddleware(opts?: MiddlewareOptions): ExpressMiddleware
  /**
   * Instruments a `ws` server: one entry per connection, close and error, and
   * optionally per message. Returns a function that removes the instrumentation.
   */
  instrumentWs(server: WebSocketServerLike, opts?: WsOptions): () => void
  /**
   * Times `fn` and attributes the elapsed time to `name` in the current request's
   * `meta.http.timings`, wherever in the call stack it runs: no request object is needed.
   * Returns `fn`'s own value (a promise stays a promise). Repeated names add up.
   *
   * Phases are self-reported totals inside server time, not a partition of it: concurrent
   * phases may sum to more than the wall-clock. At most 16 distinct phases are kept per
   * request and names are cut to 64 characters; `server` and `transit` are reserved and
   * ignored. Outside a request it just runs `fn` and records nothing.
   */
  time<T>(name: string, fn: () => T): T
  /** Like `time` for code that does not fit a callback: call the returned function to stop the clock (once). */
  phase(name: string): () => void
  /** Prints a line locally without streaming it, keeping the in-flight block intact. */
  printLine(text: string): void
  /** Final drain: undelivered batches are written to the spool for the next process. */
  close(): Promise<void>
}

/** The parts of a `ws` server the instrumentation uses, so the package needs no `ws` types. */
export interface WebSocketServerLike {
  on(event: 'connection', cb: (socket: WebSocketLike, req: IncomingMessage) => void): unknown
  off?(event: 'connection', cb: (socket: WebSocketLike, req: IncomingMessage) => void): unknown
}

export interface WebSocketLike {
  on(event: string, cb: (...args: never[]) => void): unknown
  off?(event: string, cb: (...args: never[]) => void): unknown
  send?: unknown
}

export interface WsOptions {
  /** Dimensions for every entry from this connection, read once when it opens. */
  resolveDims?: (req: IncomingMessage) => Record<string, string | undefined>
  /** Return true to ignore a connection entirely. */
  ignore?: (req: IncomingMessage) => boolean
  /**
   * `none` (default) logs only open, close and error; `meta` adds one entry per
   * message with its size and direction; `payload` also captures the message body,
   * redacted and size-capped. A busy socket makes `payload` expensive.
   */
  messages?: 'none' | 'meta' | 'payload'
  /** Cap on a captured payload. Default 2048. */
  maxPayloadBytes?: number
  /** Show open connections in the terminal's in-flight block. */
  pending?: boolean
  /** Reuse an id your application already assigned to the connection. */
  connectionId?: (req: IncomingMessage) => string | undefined
  /** Capture the caller's address. Off by default: an IP is personal data. */
  captureIp?: boolean
  /** Trusted proxy hops when reading `x-forwarded-for` for `captureIp`. Default 0. */
  trustProxyHops?: number
}

/** The low-level surface a pino or winston adapter writes through. */
export interface Sink {
  write(entry: LogEntry): void
  flush(): Promise<void>
  close(): Promise<void>
}
