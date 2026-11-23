import type { LogEntry } from '@logguber/shared'
import { createBatcher } from '../src/batcher'
import { entry } from './helpers/fixtures'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

test('cuts a batch once maxEntries is reached, without waiting for the timer', () => {
  const onBatch = vi.fn()
  const b = createBatcher({ maxEntries: 3, maxMs: 1000, maxQueue: 100, onBatch })
  for (let i = 0; i < 3; i++) b.push(entry(`m${i}`))
  expect(onBatch).toHaveBeenCalledTimes(1)
  expect(onBatch.mock.calls[0][0]).toHaveLength(3)
})

test('cuts a partial batch when maxMs elapses', () => {
  const onBatch = vi.fn()
  const b = createBatcher({ maxEntries: 100, maxMs: 1000, maxQueue: 100, onBatch })
  b.push(entry('one'))
  expect(onBatch).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1000)
  expect(onBatch).toHaveBeenCalledTimes(1)
})

test('drops oldest beyond maxQueue and reports the count with the next batch', () => {
  const onBatch = vi.fn()
  // maxEntries high so nothing drains before flush; maxQueue is what bites
  const b = createBatcher({ maxEntries: 100, maxMs: 10_000, maxQueue: 2, onBatch })
  for (const m of ['a', 'b', 'c', 'd', 'e']) b.push(entry(m))
  b.flush()
  const [entries, dropped] = onBatch.mock.calls.at(-1)!
  expect(dropped).toBe(3)
  expect(entries.map((e: any) => e.msg)).toEqual(['d', 'e'])
})

test('reports a drop count once, then resets it', () => {
  const onBatch = vi.fn()
  const b = createBatcher({ maxEntries: 100, maxMs: 10_000, maxQueue: 1, onBatch })
  b.push(entry('a')); b.push(entry('b')); b.flush()
  expect(onBatch.mock.calls.at(-1)![1]).toBe(1)
  b.push(entry('c')); b.flush()
  expect(onBatch.mock.calls.at(-1)![1]).toBe(0)
})

test('setLimits lowers the cut size when the server asks for smaller batches', () => {
  const onBatch = vi.fn()
  const b = createBatcher({ maxEntries: 100, maxMs: 1000, maxQueue: 100, onBatch })
  b.setLimits({ maxEntriesPerBatch: 2 })
  b.push(entry('a')); b.push(entry('b'))
  expect(onBatch).toHaveBeenCalledTimes(1)
})

test('setLimits cannot raise the cut size above the configured maxEntries', () => {
  const onBatch = vi.fn()
  const b = createBatcher({ maxEntries: 2, maxMs: 1000, maxQueue: 100, onBatch })
  b.setLimits({ maxEntriesPerBatch: 50 })
  b.push(entry('a')); b.push(entry('b'))
  expect(onBatch).toHaveBeenCalledTimes(1)
})

test('flush with an empty queue does not call onBatch', () => {
  const onBatch = vi.fn()
  const b = createBatcher({ maxEntries: 3, maxMs: 1000, maxQueue: 100, onBatch })
  b.flush()
  expect(onBatch).not.toHaveBeenCalled()
})

test('timer firing after a size cut does not emit an empty batch', () => {
  const onBatch = vi.fn()
  const b = createBatcher({ maxEntries: 2, maxMs: 1000, maxQueue: 100, onBatch })
  b.push(entry('a')); b.push(entry('b'))
  vi.advanceTimersByTime(5000)
  expect(onBatch).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

test('flush clears the pending timer and stats reflects the queue', () => {
  const onBatch = vi.fn()
  const b = createBatcher({ maxEntries: 100, maxMs: 1000, maxQueue: 1, onBatch })
  b.push(entry('a')); b.push(entry('b'))
  expect(b.stats()).toEqual({ queued: 1, dropped: 1 })
  b.flush()
  expect(vi.getTimerCount()).toBe(0)
  expect(b.stats()).toEqual({ queued: 0, dropped: 0 })
})

test('flush splits a backlog larger than the cut size into batches', () => {
  const onBatch = vi.fn()
  const b = createBatcher({ maxEntries: 100, maxMs: 1000, maxQueue: 100, onBatch })
  for (const m of ['a', 'b', 'c']) b.push(entry(m))
  b.setLimits({ maxEntriesPerBatch: 2 })
  b.flush()
  expect(onBatch.mock.calls.map(c => (c[0] as LogEntry[]).length)).toEqual([2, 1])
})

test('close flushes, clears the timer, is idempotent, and ignores later pushes', () => {
  const onBatch = vi.fn()
  const b = createBatcher({ maxEntries: 100, maxMs: 1000, maxQueue: 100, onBatch })
  b.push(entry('a'))
  b.close()
  expect(onBatch).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
  expect(() => b.close()).not.toThrow()
  expect(() => b.push(entry('late'))).not.toThrow()
  vi.advanceTimersByTime(5000)
  expect(onBatch).toHaveBeenCalledTimes(1)
  expect(b.stats().queued).toBe(0)
})

test('an onBatch that throws never escapes push', () => {
  const onBatch = vi.fn(() => { throw new Error('boom') })
  const b = createBatcher({ maxEntries: 1, maxMs: 1000, maxQueue: 100, onBatch })
  expect(() => b.push(entry('a'))).not.toThrow()
})
