export const LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'] as const

export type Level = (typeof LEVELS)[number]

/** The structured entry kinds. A closed set: the client's union, the gateway's
 *  validation and the console's renderers are all derived from it, so none of
 *  them can drift from the others. Anything else an entry claims is dropped. */
export const KINDS = ['request', 'mcp'] as const

export type Kind = (typeof KINDS)[number]

export const HELLO_DEFAULTS = {
  maxEntriesPerBatch: 500,
  maxBatchBytes: 1048576,
  ackWindow: 8,
} as const

export const LOKI_LIMITS = {
  maxLineBytes: 262144,
  maxMetadataEntries: 128,
  maxMetadataBytes: 65536,
} as const

export interface LogEntry {
  ts: string
  level: Level
  kind?: Kind
  msg: string
  dims?: Record<string, string>
  meta?: Record<string, unknown>
}

export interface BatchFrame {
  t: 'batch'
  id: string
  entries: LogEntry[]
  /** Entries the client dropped from its in-memory queue since the last batch it sent. */
  droppedSinceLast?: number
  /** Whole batches the client's spool pruned since the last batch it sent. A different unit
   *  from `droppedSinceLast`, so the two are reported separately and never summed. */
  prunedBatchesSinceLast?: number
}

export interface AckFrame {
  t: 'ack'
  id: string
}

export interface NackFrame {
  t: 'nack'
  id: string
  reason: string
  retryable: boolean
}

export interface HelloFrame {
  t: 'hello'
  maxEntriesPerBatch: number
  maxBatchBytes: number
  ackWindow: number
}

export type ServerFrame = HelloFrame | AckFrame | NackFrame
