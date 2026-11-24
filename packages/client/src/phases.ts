import { AsyncLocalStorage } from 'node:async_hooks'

export const MAX_PHASES = 16
export const MAX_PHASE_NAME = 64
/** Owned by the pipeline that reports them; an app-supplied phase would collide with the derived value. */
export const RESERVED_PHASE_NAMES = ['server', 'transit']

const store = new AsyncLocalStorage<Map<string, number>>()

export function runWithPhases<T>(fn: () => T): { result: T; phases: () => Record<string, number> } {
  const map = new Map<string, number>()
  const result = store.run(map, fn)
  return { result, phases: () => Object.fromEntries(map) }
}

function record(map: Map<string, number>, name: unknown, startedAt: bigint): void {
  // Timing is a side channel: whatever goes wrong here must not surface in the application.
  try {
    if (typeof name !== 'string' || name === '' || RESERVED_PHASE_NAMES.includes(name)) return
    const key = name.slice(0, MAX_PHASE_NAME)
    const known = map.has(key)
    if (!known && map.size >= MAX_PHASES) return
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6
    map.set(key, (map.get(key) ?? 0) + ms)
  } catch {
    // dropped
  }
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  try {
    return v !== null && (typeof v === 'object' || typeof v === 'function') && typeof (v as { then?: unknown }).then === 'function'
  } catch {
    return false
  }
}

/**
 * Returns `fn`'s own value, so a sync caller gets a sync result and a promise keeps its identity.
 * Recording rides a side branch on the promise; it never replaces what the caller awaits.
 */
export function timePhase<T>(name: string, fn: () => T): T {
  const map = store.getStore()
  if (!map) return fn()
  const startedAt = process.hrtime.bigint()
  let result: T
  try {
    result = fn()
  } catch (err) {
    record(map, name, startedAt)
    throw err
  }
  if (isThenable(result)) {
    // Both arms record and swallow, so the branch itself can never become an unhandled rejection.
    try {
      result.then(() => record(map, name, startedAt), () => record(map, name, startedAt))
    } catch {
      // a thenable whose then() throws is the caller's problem, not ours
    }
  } else {
    record(map, name, startedAt)
  }
  return result
}

/** For work that does not fit a callback; the returned function is idempotent. */
export function startPhase(name: string): () => void {
  const map = store.getStore()
  if (!map) return () => {}
  const startedAt = process.hrtime.bigint()
  let done = false
  return () => {
    if (done) return
    done = true
    record(map, name, startedAt)
  }
}
