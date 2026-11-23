import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createSpool } from '../src/spool'
import { batch, entry, tmp } from './helpers/fixtures'

test('round-trips a batch and deletes it only on ack', () => {
  const s = createSpool({ dir: tmp() })
  s.push({ t: 'batch', id: '01A', entries: [entry('hello')] })
  expect(s.count()).toBe(1)
  const [claimed] = s.claim(10)
  expect(claimed.batch.entries[0].msg).toBe('hello')
  expect(s.count()).toBe(1) // still present until acked
  s.ack('01A')
  expect(s.count()).toBe(0)
})

test('claims oldest first and does not hand the same row to a second caller', () => {
  const s = createSpool({ dir: tmp() })
  s.push(batch('01A')); s.push(batch('01B'))
  expect(s.claim(1)[0].id).toBe('01A')
  expect(s.claim(1)[0].id).toBe('01B')
  expect(s.claim(1)).toHaveLength(0)
})

test('release returns a claimed row for retry and counts the attempt', () => {
  const dir = tmp()
  const s = createSpool({ dir })
  s.push(batch('01A')); s.claim(1); s.release('01A')
  expect(s.claim(1)[0].id).toBe('01A')
  const db = new DatabaseSync(path.join(dir, 'spool.db'))
  expect(db.prepare('SELECT attempts FROM spool WHERE id = ?').get('01A')).toMatchObject({ attempts: 1 })
  db.close()
})

test('prunes oldest rows past maxBytes and counts what it dropped', () => {
  const s = createSpool({ dir: tmp(), maxBytes: 2000 })
  for (let i = 0; i < 50; i++) s.push(batch(`id${i}`, 'x'.repeat(200)))
  expect(s.prunedCount()).toBeGreaterThan(0)
  expect(s.claim(1)[0].id).not.toBe('id0')
  expect(s.count() + s.prunedCount()).toBe(50)
  expect(s.count()).toBeLessThan(10)
})

test('prunedCount is cumulative and does not reset on read', () => {
  const s = createSpool({ dir: tmp(), maxBytes: 1000 })
  for (let i = 0; i < 20; i++) s.push(batch(`id${i}`, 'x'.repeat(200)))
  const first = s.prunedCount()
  expect(first).toBeGreaterThan(0)
  expect(s.prunedCount()).toBe(first)
})

test('prunes rows older than maxAge', () => {
  vi.useFakeTimers()
  try {
    const s = createSpool({ dir: tmp(), maxAge: 1000 })
    s.push(batch('old'))
    vi.advanceTimersByTime(5000)
    expect(s.prune()).toBe(1)
    expect(s.count()).toBe(0)
    expect(s.prunedCount()).toBe(1)
  } finally {
    vi.useRealTimers()
  }
})

test('creates the spool directory when it does not exist yet', () => {
  const dir = path.join(tmp(), 'a', 'b')
  const s = createSpool({ dir })
  expect(s.available()).toBe(true)
  s.push(batch('01A'))
  expect(s.count()).toBe(1)
})

// Review Focus: an unwritable directory must degrade, not crash
test('falls back to unavailable instead of throwing when the directory cannot be written', () => {
  const ro = tmp(); fs.chmodSync(ro, 0o400)
  const onError = vi.fn()
  const s = createSpool({ dir: ro, onError })
  expect(s.available()).toBe(false)
  expect(() => s.push(batch('01A'))).not.toThrow()
  expect(s.claim(5)).toEqual([])
  expect(s.count()).toBe(0)
  expect(onError).toHaveBeenCalled()
  fs.chmodSync(ro, 0o700)
})

// Review Focus: a corrupt database file must not wedge startup
test('recreates the database when the file is not valid SQLite', () => {
  const dir = tmp(); fs.writeFileSync(path.join(dir, 'spool.db'), 'not a database')
  const s = createSpool({ dir, onError: () => {} })
  expect(() => s.push(batch('01A'))).not.toThrow()
  expect(s.available()).toBe(true)
  expect(s.count()).toBe(1)
})

test('two spools on the same file never claim the same batch', () => {
  const dir = tmp()
  const a = createSpool({ dir }); const b = createSpool({ dir })
  a.push(batch('01A')); a.push(batch('01B'))
  const got = [...a.claim(1), ...b.claim(1), ...a.claim(1), ...b.claim(1)].map((c) => c.id)
  expect(got.sort()).toEqual(['01A', '01B'])
})

test('rows survive a restart', () => {
  const dir = tmp()
  const a = createSpool({ dir }); a.push(batch('01A')); a.close()
  const b = createSpool({ dir })
  expect(b.claim(1)[0].id).toBe('01A')
})

test('close is idempotent and later calls are harmless no-ops', () => {
  const s = createSpool({ dir: tmp() })
  s.push(batch('01A'))
  s.close()
  expect(() => s.close()).not.toThrow()
  expect(() => s.push(batch('01B'))).not.toThrow()
  expect(s.claim(1)).toEqual([])
  expect(s.count()).toBe(0)
  expect(() => { s.ack('01A'); s.release('01A'); s.prune() }).not.toThrow()
  expect(s.available()).toBe(false)
})

test('claim with zero, negative or fractional n claims nothing', () => {
  const s = createSpool({ dir: tmp() })
  s.push(batch('01A'))
  expect(s.claim(0)).toEqual([])
  expect(s.claim(-3)).toEqual([])
  expect(s.claim(NaN)).toEqual([])
  expect(s.claim(1)[0].id).toBe('01A')
})

test('a row whose body is unreadable is discarded, reported and counted as pruned', () => {
  const dir = tmp()
  const onError = vi.fn()
  const s = createSpool({ dir, onError })
  s.push(batch('01A')); s.push(batch('01B'))
  const db = new DatabaseSync(path.join(dir, 'spool.db'))
  db.prepare('UPDATE spool SET body = ? WHERE id = ?').run(Buffer.from('{not json'), '01A')
  db.close()
  expect(s.claim(10).map((c) => c.id)).toEqual(['01B'])
  expect(onError).toHaveBeenCalled()
  expect(s.count()).toBe(1)
  expect(s.prunedCount()).toBe(1)
})

test('a failing write is reported and does not throw', () => {
  const dir = tmp()
  const onError = vi.fn()
  const s = createSpool({ dir, onError })
  const db = new DatabaseSync(path.join(dir, 'spool.db'))
  db.exec('DROP TABLE spool') // simulate the store breaking under us
  db.close()
  expect(() => s.push(batch('01A'))).not.toThrow()
  expect(onError).toHaveBeenCalled()
})

describe('stale claim reclaim', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const attempts = (dir: string, id: string) => {
    const db = new DatabaseSync(path.join(dir, 'spool.db'))
    const row = db.prepare('SELECT attempts FROM spool WHERE id = ?').get(id) as { attempts: number }
    db.close()
    return row.attempts
  }

  test('a claim older than staleClaimMs is returned by the next claim and counts an attempt', () => {
    const dir = tmp()
    const s = createSpool({ dir, staleClaimMs: 1000 })
    s.push(batch('01A')); s.claim(1)
    vi.advanceTimersByTime(1500)
    expect(s.claim(1).map((c) => c.id)).toEqual(['01A'])
    expect(attempts(dir, '01A')).toBe(1)
  })

  test('a claim newer than staleClaimMs is not returned', () => {
    const s = createSpool({ dir: tmp(), staleClaimMs: 1000 })
    s.push(batch('01A')); s.claim(1)
    vi.advanceTimersByTime(500)
    expect(s.claim(1)).toEqual([])
  })

  test('a reclaimed row is still deleted by ack', () => {
    const s = createSpool({ dir: tmp(), staleClaimMs: 1000 })
    s.push(batch('01A')); s.claim(1)
    vi.advanceTimersByTime(1500)
    s.claim(1); s.ack('01A')
    expect(s.count()).toBe(0)
  })

  test('the stale sweep does not resurrect an acked row', () => {
    const s = createSpool({ dir: tmp(), staleClaimMs: 1000 })
    s.push(batch('01A')); s.claim(1); s.ack('01A')
    vi.advanceTimersByTime(5000)
    expect(s.claim(1)).toEqual([])
    expect(s.count()).toBe(0)
  })

  test('defaults to 60s', () => {
    const s = createSpool({ dir: tmp() })
    s.push(batch('01A')); s.claim(1)
    vi.advanceTimersByTime(59000)
    expect(s.claim(1)).toEqual([])
    vi.advanceTimersByTime(2000)
    expect(s.claim(1)).toHaveLength(1)
  })
})
