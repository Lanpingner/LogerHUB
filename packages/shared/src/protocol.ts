export const LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'] as const

export type Level = (typeof LEVELS)[number]

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
  kind?: 'request'
  msg: string
  dims?: Record<string, string>
  meta?: Record<string, unknown>
}

export interface BatchFrame {
  t: 'batch'
  id: string
  entries: LogEntry[]
  droppedSinceLast?: number
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
