import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildSpool, createSpool } from '../src/spool'
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
// root ignores directory modes, so the premise does not hold there
test.skipIf(process.getuid?.() === 0)('falls back to unavailable instead of throwing when the directory cannot be written', () => {
  const ro = tmp()
  fs.chmodSync(ro, 0o400)
  try {
    const onError = vi.fn()
    const s = createSpool({ dir: ro, onError })
    expect(s.available()).toBe(false)
    expect(() => s.push(batch('01A'))).not.toThrow()
    expect(s.claim(5)).toEqual([])
    expect(s.count()).toBe(0)
    expect(onError).toHaveBeenCalled()
  } finally {
    fs.chmodSync(ro, 0o700)
  }
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
  const a = createSpool({ dir }); const b = createSpool({ dir }) // two separate connections
  for (let i = 0; i < 6; i++) a.push(batch(`id${i}`))
  const got: string[] = []
  for (let i = 0; i < 4; i++) got.push(...a.claim(1).map((c) => c.id), ...b.claim(1).map((c) => c.id))
  expect(got.sort()).toEqual(['id0', 'id1', 'id2', 'id3', 'id4', 'id5'])
})

test('claim takes the write lock up front, and a lock timeout leaves nothing half-claimed', () => {
  const dir = tmp()
  const onError = vi.fn()
  const s = createSpool({ dir, busyTimeoutMs: 20, onError })
  s.push(batch('01A'))
  const other = new DatabaseSync(path.join(dir, 'spool.db'))
  other.exec('BEGIN IMMEDIATE') // a sibling worker mid-claim
  expect(s.claim(1)).toEqual([])
  expect(onError).toHaveBeenCalled()
  other.exec('ROLLBACK'); other.close()
  // the failed claim left no transaction open and no row claimed
  expect(s.claim(1).map((c) => c.id)).toEqual(['01A'])
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

describe('hardening', () => {
  test('a pre-existing spool table of the wrong shape is replaced, not thrown', () => {
    const dir = tmp()
    const old = new DatabaseSync(path.join(dir, 'spool.db'))
    old.exec('CREATE TABLE spool (id TEXT PRIMARY KEY, payload TEXT)')
    old.close()
    const onError = vi.fn()
    let s!: ReturnType<typeof createSpool>
    expect(() => { s = createSpool({ dir, onError }) }).not.toThrow()
    expect(s.available()).toBe(true)
    s.push(batch('01A'))
    expect(s.claim(1)[0].id).toBe('01A')
    expect(onError).toHaveBeenCalled()
  })

  test('a single batch larger than maxBytes is rejected without touching existing rows', () => {
    const onError = vi.fn()
    const s = createSpool({ dir: tmp(), maxBytes: 1000, onError })
    s.push(batch('small1')); s.push(batch('small2'))
    s.push(batch('huge', 'x'.repeat(5000)))
    expect(s.count()).toBe(2)
    expect(s.prunedCount()).toBe(1)
    expect(onError).toHaveBeenCalled()
    expect(s.claim(5).map((c) => c.id)).toEqual(['small1', 'small2'])
  })

  test('size pruning evicts oldest first and never the row just pushed', () => {
    const s = createSpool({ dir: tmp(), maxBytes: 1500 })
    for (let i = 0; i < 4; i++) s.push(batch(`id${i}`, 'x'.repeat(300)))
    const ids = s.claim(10).map((c) => c.id)
    expect(ids.at(-1)).toBe('id3')
    expect(ids).not.toContain('id0')
  })

  test('size pruning prefers unclaimed rows over in-flight ones', () => {
    const s = createSpool({ dir: tmp(), maxBytes: 1500 })
    s.push(batch('flight', 'x'.repeat(300)))
    expect(s.claim(1)).toHaveLength(1)
    for (let i = 0; i < 4; i++) s.push(batch(`id${i}`, 'x'.repeat(300)))
    expect(s.prunedCount()).toBeGreaterThan(0)
    s.release('flight') // still present: it was evicted last
    expect(s.claim(10).map((c) => c.id)).toContain('flight')
  })

  test('the running byte total tracks acks so ack-then-push does not over-prune', () => {
    const s = createSpool({ dir: tmp(), maxBytes: 1500 })
    for (let i = 0; i < 20; i++) {
      s.push(batch(`id${i}`, 'x'.repeat(300)))
      for (const c of s.claim(1)) s.ack(c.id)
    }
    expect(s.prunedCount()).toBe(0)
  })

  test('releasing an unclaimed row is a no-op and does not count an attempt', () => {
    const dir = tmp()
    const s = createSpool({ dir })
    s.push(batch('01A')); s.release('01A')
    const db = new DatabaseSync(path.join(dir, 'spool.db'))
    expect(db.prepare('SELECT attempts FROM spool WHERE id = ?').get('01A')).toMatchObject({ attempts: 0 })
    db.close()
  })

  test('a failed claim-mark rolls back and does not delete a healthy row', () => {
    const dir = tmp()
    const onError = vi.fn()
    const s = createSpool({ dir, onError })
    s.push(batch('01A'))
    const db = new DatabaseSync(path.join(dir, 'spool.db'))
    db.exec(`CREATE TRIGGER no_mark BEFORE UPDATE OF claimed_at ON spool
             WHEN NEW.claimed_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
    expect(s.claim(1)).toEqual([])
    expect(onError).toHaveBeenCalled()
    expect(s.count()).toBe(1)
    expect(s.prunedCount()).toBe(0)
    db.exec('DROP TRIGGER no_mark'); db.close()
    expect(s.claim(1).map((c) => c.id)).toEqual(['01A']) // no transaction left open
  })

  test('pruned is not counted when the transaction rolls back', () => {
    const dir = tmp()
    const s = createSpool({ dir, maxBytes: 600 })
    s.push(batch('a', 'x'.repeat(100)))
    const db = new DatabaseSync(path.join(dir, 'spool.db'))
    db.exec(`CREATE TRIGGER no_del BEFORE DELETE ON spool BEGIN SELECT RAISE(ABORT, 'io'); END`)
    s.push(batch('b', 'x'.repeat(300))); s.push(batch('c', 'x'.repeat(300)))
    expect(s.prunedCount()).toBe(0)
    db.close()
  })

  test('a non-schema SQLITE_ERROR at open leaves the file untouched and the spool unavailable', () => {
    const dir = tmp(); const f = path.join(dir, 'spool.db')
    const foreign = new DatabaseSync(f)
    foreign.exec('CREATE TABLE precious (v TEXT); INSERT INTO precious VALUES (\'keep\')')
    foreign.exec('CREATE VIEW spool AS SELECT v AS id FROM precious') // index creation fails: "views may not be indexed"
    foreign.close()
    const onError = vi.fn()
    const s = createSpool({ dir, onError })
    expect(s.available()).toBe(false)
    expect(onError).toHaveBeenCalled()
    const check = new DatabaseSync(f)
    expect(check.prepare('SELECT v FROM precious').get()).toMatchObject({ v: 'keep' })
    check.close()
  })

  test('two workers on one directory: a re-seed counts both and pruning restores the combined bound', () => {
    const dir = tmp()
    const opts = { dir, maxBytes: 3000, reseedEvery: 1_000_000 }
    const a = createSpool(opts); const b = createSpool(opts)
    // Each sees only its own writes, so neither prunes on push.
    for (let i = 0; i < 6; i++) { a.push(batch(`a${i}`, 'x'.repeat(200))); b.push(batch(`b${i}`, 'x'.repeat(200))) }
    expect(a.prunedCount() + b.prunedCount()).toBe(0)
    const db = new DatabaseSync(path.join(dir, 'spool.db'))
    const total = () => Number((db.prepare('SELECT SUM(length(body)) AS n FROM spool').get() as { n: number }).n)
    expect(total()).toBeGreaterThan(3000)
    a.prune() // re-seeds from the database: sees both workers' rows
    expect(total()).toBeLessThanOrEqual(3000)
    expect(a.prunedCount()).toBeGreaterThan(0)
    db.close()
  })

  test('push re-seeds from the database every reseedEvery pushes', () => {
    const dir = tmp()
    const opts = { dir, maxBytes: 6000, reseedEvery: 4 }
    const a = createSpool(opts); const b = createSpool(opts)
    for (let i = 0; i < 12; i++) { a.push(batch(`a${i}`, 'x'.repeat(200))); b.push(batch(`b${i}`, 'x'.repeat(200))) }
    const db = new DatabaseSync(path.join(dir, 'spool.db'))
    const total = Number((db.prepare('SELECT SUM(length(body)) AS n FROM spool').get() as { n: number }).n)
    db.close()
    expect(total).toBeLessThanOrEqual(6600) // without re-seeding this reaches ~7100
  })

  // A sibling holding an exclusive lock on a fresh file makes our open fail with SQLITE_BUSY.
  function lockedFile() {
    const dir = tmp()
    const raw = new DatabaseSync(path.join(dir, 'spool.db'))
    raw.exec('CREATE TABLE other (v TEXT)')
    raw.exec('BEGIN EXCLUSIVE')
    return { dir, raw }
  }

  test('a transient SQLITE_BUSY at open is retried and the spool comes up without reporting', () => {
    const { dir, raw } = lockedFile()
    const onError = vi.fn()
    const sleep = vi.fn(() => { raw.exec('COMMIT'); raw.close() }) // the sibling finishes during the backoff
    const s = buildSpool({ dir, busyTimeoutMs: 5, onError }, { sleep })
    expect(sleep).toHaveBeenCalledWith(50)
    expect(s.available()).toBe(true)
    expect(onError).not.toHaveBeenCalled()
    s.push(batch('01A'))
    expect(s.count()).toBe(1)
  })

  test('a persistent SQLITE_BUSY ends in the no-op spool after bounded attempts', () => {
    const { dir, raw } = lockedFile()
    const onError = vi.fn()
    const sleep = vi.fn()
    const s = buildSpool({ dir, busyTimeoutMs: 5, onError }, { sleep })
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([50, 100])
    expect(s.available()).toBe(false)
    expect(onError).toHaveBeenCalledTimes(1)
    raw.exec('ROLLBACK'); raw.close()
  })

  test.skipIf(process.getuid?.() === 0)('close() after a failed recovery does not double-close or report', () => {
    const dir = tmp(); const onError = vi.fn()
    const s = createSpool({ dir, onError })
    for (let i = 0; i < 30; i++) s.push(batch(`a${i}`, 'x'.repeat(500)))
    const f = path.join(dir, 'spool.db')
    const w = new DatabaseSync(f); w.exec('PRAGMA wal_checkpoint(TRUNCATE)'); w.close()
    const size = fs.statSync(f).size
    const fd = fs.openSync(f, 'r+'); fs.writeSync(fd, Buffer.alloc(size - 4096, 0x5a), 0, size - 4096, 4096); fs.closeSync(fd)
    fs.chmodSync(dir, 0o500)
    try {
      s.count()
      expect(s.available()).toBe(false) // precondition: recovery really failed
      const before = onError.mock.calls.length
      s.close()
      expect(onError.mock.calls.length).toBe(before)
    } finally {
      fs.chmodSync(dir, 0o700)
    }
  })

  test('mid-life recovery from a public method never sleeps (no backoff on the request path)', () => {
    const dir = tmp(); const sleep = vi.fn()
    const onError = vi.fn()
    const s = buildSpool({ dir, onError }, { sleep })
    for (let i = 0; i < 30; i++) s.push(batch(`a${i}`, 'x'.repeat(500)))
    const f = path.join(dir, 'spool.db')
    const w = new DatabaseSync(f); w.exec('PRAGMA wal_checkpoint(TRUNCATE)'); w.close()
    const size = fs.statSync(f).size
    const fd = fs.openSync(f, 'r+'); fs.writeSync(fd, Buffer.alloc(size - 4096, 0x5a), 0, size - 4096, 4096); fs.closeSync(fd)
    s.count()
    expect(onError).toHaveBeenCalled() // precondition: corruption was really detected
    expect(s.available()).toBe(true) // recovered...
    expect(sleep).not.toHaveBeenCalled() // ...without a backoff
  })

  test.skipIf(process.getuid?.() === 0)('a failed recovery is retried once per cooldown window, not latched forever', () => {
    vi.useFakeTimers()
    const dir = tmp(); const onError = vi.fn()
    const s = buildSpool({ dir, onError }, { recoveryCooldownMs: 5000 })
    try {
      for (let i = 0; i < 30; i++) s.push(batch(`a${i}`, 'x'.repeat(500)))
      const f = path.join(dir, 'spool.db')
      const w = new DatabaseSync(f); w.exec('PRAGMA wal_checkpoint(TRUNCATE)'); w.close()
      const size = fs.statSync(f).size
      const fd = fs.openSync(f, 'r+'); fs.writeSync(fd, Buffer.alloc(size - 4096, 0x5a), 0, size - 4096, 4096); fs.closeSync(fd)
      fs.chmodSync(dir, 0o500) // obstruction: recovery cannot delete the damaged file
      s.count()
      expect(s.available()).toBe(false)
      const afterFirst = onError.mock.calls.length
      vi.advanceTimersByTime(1000)
      s.count(); s.push(batch('x'))
      expect(onError.mock.calls.length).toBe(afterFirst) // within the cooldown: no new attempt
      vi.advanceTimersByTime(5000)
      s.count()
      expect(onError.mock.calls.length).toBe(afterFirst + 1) // after it: exactly one attempt, still failing
      expect(s.available()).toBe(false)
      fs.chmodSync(dir, 0o700) // obstruction removed
      vi.advanceTimersByTime(6000)
      s.push(batch('back'))
      expect(s.available()).toBe(true)
      expect(s.claim(1)[0].id).toBe('back')
    } finally {
      fs.chmodSync(dir, 0o700)
      vi.useRealTimers()
    }
  })

  function corruptPages(dir: string) {
    const f = path.join(dir, 'spool.db')
    const w = new DatabaseSync(f); w.exec('PRAGMA wal_checkpoint(TRUNCATE)'); w.close()
    const size = fs.statSync(f).size
    const fd = fs.openSync(f, 'r+') // keep page 1 (the header) intact: damage is mid-life, not at open
    fs.writeSync(fd, Buffer.alloc(size - 4096, 0x5a), 0, size - 4096, 4096)
    fs.closeSync(fd)
  }
  const fill = (s: ReturnType<typeof createSpool>) => { for (let i = 0; i < 30; i++) s.push(batch(`a${i}`, 'x'.repeat(500))) }

  test('mid-life page corruption is reported and the spool recovers onto a fresh file', () => {
    const dir = tmp(); const onError = vi.fn()
    const s = createSpool({ dir, onError })
    fill(s); corruptPages(dir)
    expect(s.count()).toBe(0)
    expect(onError).toHaveBeenCalled()
    expect(s.available()).toBe(true)
    s.push(batch('after'))
    expect(s.claim(1)[0].id).toBe('after')
  })

  test.skipIf(process.getuid?.() === 0)('available() is false once mid-life corruption cannot be recovered', () => {
    const dir = tmp(); const onError = vi.fn()
    const s = createSpool({ dir, onError })
    fill(s); corruptPages(dir)
    fs.chmodSync(dir, 0o500) // recovery cannot delete the damaged file
    try {
      expect(() => s.count()).not.toThrow()
      expect(s.available()).toBe(false)
      expect(() => s.push(batch('x'))).not.toThrow()
    } finally {
      fs.chmodSync(dir, 0o700)
    }
  })
})
