/** Client-facing option types only. Wire types live in `@logguber/shared`. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Kind, LogEntry } from '@logguber/shared'

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
  /**
   * Which stream the lines go to. `stdout` by default.
   *
   * Set it to `stderr` in any process whose stdout carries a protocol — every
   * stdio MCP server — because a log line written into that stream corrupts
   * every JSON-RPC frame after it. Not detected automatically: a process cannot
   * tell a pipe from a terminal, and guessing wrong either way is worse than
   * saying which you have.
   */
  output?: 'stdout' | 'stderr'
  /** Defaults to whether the chosen stream is a TTY. `NO_COLOR` always wins. */
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
  /**
   * Duration column on request lines. `'split'` (default) prints `12ms+3ms`, server time
   * then transit time, and widens the column; it falls back to `+15ms` when either half is
   * missing. `'total'` is the original pinned format, byte for byte, for anyone comparing
   * against a logger with that layout.
   */
  timing?: 'split' | 'total'
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
   * Marks the entry as a structured record: `request` from the Express middleware, `mcp` from
   * the MCP capture. Honoured by `log()` only, so the level methods never produce one. `log()`
   * honours it from any caller by design (a pino/winston adapter needs it), so usage counts
   * derived from a kind trust the application not to forge one.
   */
  kind?: Kind
}

export type McpCapture = 'never' | 'on-error' | 'always'

/** Shared by the primitive and both wrappers. */
export interface McpCaptureOptions {
  /**
   * `always` (the default) captures arguments and results for every call;
   * `on-error` only for calls that failed; `never` neither. Unlike HTTP bodies,
   * which default to `on-error`, this defaults to capturing: MCP call volume is
   * far lower and the arguments are most of the record. The same redaction and
   * the same size cap apply either way.
   */
  capture?: McpCapture
  /** Captured arguments or results larger than this become a truncation marker. Default 8192. */
  maxBodyBytes?: number
  /** When set, only these top-level fields of a captured payload are kept. */
  allowFields?: string[]
}

/** One finished MCP tool call, for `logger.mcpCall`. */
export interface McpCall extends McpCaptureOptions {
  /** The tool's name. Becomes the `tool:` search field. */
  tool: string
  /** `server` (default) means this process served the call; `client` means it made it. */
  role?: 'server' | 'client'
  /** Which MCP server: the one serving, or the one called. */
  server?: string
  /** Reuse an id your application already has; otherwise one is generated. */
  callId?: string
  durationMs?: number
  /** The tool's arguments. Redacted and size-capped before it leaves the process. */
  args?: unknown
  /** What the tool returned. A result carrying `isError: true` counts as a failure. */
  result?: unknown
  /** Whatever was thrown. Recorded as its name and message; never a stack. */
  error?: unknown
  /** Inferred from `error` and `result` when omitted. */
  ok?: boolean
  /** A short note rendered on the console line, such as why a call was refused. */
  note?: string
  /** Short labels appended to the console line, as `meta.http.tags` is for a request. */
  tags?: Record<string, unknown>
  /** Short flags appended to the console line. */
  flags?: string[]
  dims?: Record<string, string>
  /** Phase totals, in the shape `logger.time` produces. */
  timings?: Record<string, number>
  /** Extra fields for `meta.mcp`. They cannot overwrite a measured field. */
  meta?: Record<string, unknown>
}

/** Hooks evaluated per call. Every one of them is guarded: a throwing hook
 *  costs its own field and never the tool call. */
export interface McpToolOptions<A extends unknown[] = unknown[]> extends McpCaptureOptions {
  /** Which MCP server this is, recorded on every call. */
  server?: string
  /** Return true to skip a call entirely. The tool still runs, untouched. */
  ignore?: (...args: A) => boolean
  /** Dimensions for the entry, such as the calling user. */
  resolveDims?: (...args: A) => Record<string, string | undefined>
  /** Extra fields for `meta.mcp`; `tags`, `flags` and `note` are rendered on the console line. */
  resolveMeta?: (...args: A) => Record<string, unknown> | undefined
  /**
   * What to record as the call's arguments. By default the first parameter's
   * `params.arguments`, `arguments` or `args` — covering both an SDK request and
   * a bare call descriptor — and otherwise the first parameter itself.
   */
  args?: (...args: A) => unknown
  /** A short note for the console line. */
  note?: (...args: A) => string | undefined
  /** Reuse an id your application already assigned to this call. */
  callId?: (...args: A) => string | undefined
}

export interface McpClientOptions<A extends unknown[] = unknown[]> extends McpToolOptions<A> {
  /** The tool being called. By default the first parameter's `name`, `tool` or `params.name`. */
  tool?: (...args: A) => string | undefined
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
   * Records one finished MCP tool call as a `kind: 'mcp'` entry. The low-level
   * primitive: use it when you already have the timing, or when your server
   * dispatches tools through its own router. `wrapMcpTool` and `wrapMcpClient`
   * are measuring shells over this.
   */
  mcpCall(call: McpCall): void
  /**
   * Wraps an MCP tool handler so the calls this process *serves* are recorded:
   * tool, arguments, result, duration and failure. Returns a function with the
   * handler's own signature — a sync handler stays sync, a promise stays the
   * same promise — and the handler's result or error always reaches the caller
   * untouched.
   *
   * Phases reported with `logger.time()` anywhere beneath the handler land in
   * `meta.mcp.timings`.
   *
   * On a stdio MCP server, set `console: { output: 'stderr' }` on the logger:
   * stdout is the protocol stream and a log line written there corrupts every
   * frame after it.
   */
  wrapMcpTool<A extends unknown[], R>(tool: string, handler: (...args: A) => R, opts?: McpToolOptions<A>): (...args: A) => R
  /**
   * Wraps an outbound tool call so the tools this process *uses* are recorded,
   * the same measurement from the other end. The tool name comes from the call
   * argument (`{ name }`, `{ tool }` or `{ params: { name } }`) unless `opts.tool`
   * says otherwise.
   */
  wrapMcpClient<A extends unknown[], R>(call: (...args: A) => R, opts?: McpClientOptions<A>): (...args: A) => R
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
