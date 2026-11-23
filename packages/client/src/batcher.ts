import type { LogEntry } from '@logguber/shared'

export interface BatcherOptions {
  maxEntries: number
  maxMs: number
  /** Hard bound on queued entries; the oldest are dropped beyond it. Default 10000. */
  maxQueue?: number
  /** `droppedSinceLast` is reported exactly once, then reset. */
  onBatch: (entries: LogEntry[], droppedSinceLast: number) => void
}

export interface Batcher {
  push(e: LogEntry): void
  flush(): void
  setLimits(l: { maxEntriesPerBatch: number }): void
  stats(): { queued: number; dropped: number }
  close(): void
}

const DEFAULT_MAX_QUEUE = 10_000

export function createBatcher(opts: BatcherOptions): Batcher {
  const maxQueue = Math.max(1, opts.maxQueue ?? DEFAULT_MAX_QUEUE)
  let cutSize = Math.max(1, opts.maxEntries)
  let queue: LogEntry[] = []
  let dropped = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  function clearTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  function emit(entries: LogEntry[]): void {
    const count = dropped
    dropped = 0
    try {
      opts.onBatch(entries, count)
    } catch {
      // Never throw into application code.
    }
  }

  /** Cut one batch of at most cutSize entries. */
  function cut(): void {
    clearTimer()
    if (queue.length === 0) return
    const entries = queue.splice(0, cutSize)
    emit(entries)
    if (queue.length > 0) arm()
  }

  function arm(): void {
    if (timer !== undefined || closed) return
    timer = setTimeout(() => {
      timer = undefined
      cut()
    }, opts.maxMs)
    timer.unref?.()
  }

  function flush(): void {
    clearTimer()
    while (queue.length > 0) {
      emit(queue.splice(0, cutSize))
    }
  }

  return {
    push(e) {
      if (closed) return
      queue.push(e)
      if (queue.length > maxQueue) {
        queue.shift()
        dropped++
      }
      if (queue.length >= cutSize) cut()
      else arm()
    },
    flush,
    setLimits(l) {
      if (Number.isFinite(l.maxEntriesPerBatch) && l.maxEntriesPerBatch >= 1) {
        cutSize = Math.min(cutSize, Math.floor(l.maxEntriesPerBatch))
      }
    },
    stats: () => ({ queued: queue.length, dropped }),
    close() {
      if (closed) return
      flush()
      closed = true
      clearTimer()
    },
  }
}
