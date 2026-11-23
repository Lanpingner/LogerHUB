/** Client-facing option types only. Wire types live in `@logguber/shared`. */
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
}

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
  /** Final drain: undelivered batches are written to the spool for the next process. */
  close(): Promise<void>
}

/** The low-level surface a pino or winston adapter writes through. */
export interface Sink {
  write(entry: LogEntry): void
  flush(): Promise<void>
  close(): Promise<void>
}
