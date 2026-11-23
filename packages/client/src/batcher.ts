import type { LogEntry } from '@logguber/shared'

export interface BatcherOptions {
  maxEntries: number
  maxMs: number
  /** Hard bound on queued entries; the oldest are dropped beyond it. Default 10000. */
  maxQueue?: number
  /** `droppedSinceLast` is reported exactly once, then reset. */
  onBatch: (entries: LogEntry[], droppedSinceLast: number) => void
  /** Called when onBatch throws; the failed batch is counted as dropped. */
  onError?: (e: Error) => void
}

export interface Batcher {
  push(e: LogEntry): void
  flush(): void
  setLimits(l: { maxEntriesPerBatch: number }): void
  stats(): { queued: number; dropped: number }
  close(): void
}

const DEFAULT_MAX_QUEUE = 10_000
const DEFAULT_MAX_MS = 1000

/** Finite integer >= 1, otherwise the fallback. */
function sane(n: number | undefined, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
}

export function createBatcher(opts: BatcherOptions): Batcher {
  const maxQueue = sane(opts.maxQueue, DEFAULT_MAX_QUEUE)
  const maxMs = sane(opts.maxMs, DEFAULT_MAX_MS)
  const configuredCutSize = sane(opts.maxEntries, 1)
  let cutSize = configuredCutSize
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
    } catch (err) {
      // Never throw into application code. The batch is lost, but visibly:
      // restore the drop count and add the failed entries to it.
      dropped += count + entries.length
      try {
        opts.onError?.(err instanceof Error ? err : new Error(String(err)))
      } catch {
        // onError must not throw into application code either.
      }
    }
  }

  /** Cut one batch (partial if timer-driven), then keep cutting full batches. */
  function cut(): void {
    clearTimer()
    if (queue.length === 0) return
    emit(queue.splice(0, cutSize))
    while (queue.length >= cutSize) emit(queue.splice(0, cutSize))
    if (queue.length > 0) arm()
  }

  function arm(): void {
    if (timer !== undefined || closed) return
    timer = setTimeout(() => {
      timer = undefined
      cut()
    }, maxMs)
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
      if (closed) {
        dropped++
        return
      }
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
      // Relative to the configured size, not the current one: a gateway that announces a larger
      // limit after a reconnect must be able to restore it, but never exceed what was configured.
      if (Number.isFinite(l.maxEntriesPerBatch) && l.maxEntriesPerBatch >= 1) {
        cutSize = Math.min(configuredCutSize, Math.floor(l.maxEntriesPerBatch))
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
