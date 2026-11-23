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
  /** Every internal failure, rate-limited per cause. Defaults to one `console.warn` per interval. */
  onError?: (e: Error) => void
}

export interface LogOptions {
  dims?: Record<string, string>
  meta?: Record<string, unknown>
  /**
   * Marks the entry as a request record. Set by the Express middleware; honoured by `log()`
   * only, so the level methods never produce it.
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
}

export type ExpressMiddleware = (req: RequestLike, res: ServerResponse, next: (err?: unknown) => void) => void

export type LogMethod = (msg: string, opts?: LogOptions) => void

export interface Logger {
  /** Any string is accepted; an unknown level is recorded as `info`. */
  log(level: string, msg: string, opts?: LogOptions): void
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
  /** Final drain: undelivered batches are written to the spool for the next process. */
  close(): Promise<void>
}

/** The low-level surface a pino or winston adapter writes through. */
export interface Sink {
  write(entry: LogEntry): void
  flush(): Promise<void>
  close(): Promise<void>
}
