import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { BatchFrame } from '@logguber/shared'

export interface SpoolOptions {
  dir: string
  /** Cap on the summed size of stored batch bodies. Default 256MB. */
  maxBytes?: number
  /** Rows older than this (ms) are dropped. Default 7 days. */
  maxAge?: number
  onError?: (e: Error) => void
}

export interface Spool {
  push(batch: BatchFrame): void
  claim(n: number): Array<{ id: string; batch: BatchFrame }>
  ack(id: string): void
  release(id: string): void
  prune(): number
  count(): number
  /** Cumulative rows dropped by pruning or unreadable bodies. Never resets. */
  prunedCount(): number
  available(): boolean
  close(): void
}

const DEFAULT_MAX_BYTES = 268435456
const DEFAULT_MAX_AGE = 604800000
const DB_FILE = 'spool.db'
// SQLITE_CORRUPT and SQLITE_NOTADB: the only failures worth deleting the file for.
const CORRUPT_CODES = new Set([11, 26])

const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))

function noopSpool(): Spool {
  return {
    push() {},
    claim: () => [],
    ack() {},
    release() {},
    prune: () => 0,
    count: () => 0,
    prunedCount: () => 0,
    available: () => false,
    close() {},
  }
}

function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(`CREATE TABLE IF NOT EXISTS spool (
      id TEXT PRIMARY KEY,
      body BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_at INTEGER
    )`)
    db.exec('CREATE INDEX IF NOT EXISTS spool_created_at ON spool (created_at)')
    return db
  } catch (e) {
    try { db.close() } catch { /* already unusable */ }
    throw e
  }
}

function removeDbFiles(file: string): void {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true })
}

export function createSpool(opts: SpoolOptions): Spool {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const maxAge = opts.maxAge ?? DEFAULT_MAX_AGE
  const report = (e: unknown): void => {
    try { opts.onError?.(toError(e)) } catch { /* a throwing handler must not crash the host */ }
  }

  let db: DatabaseSync
  try {
    fs.mkdirSync(opts.dir, { recursive: true })
    const file = path.join(opts.dir, DB_FILE)
    try {
      db = openDb(file)
    } catch (e) {
      const code = (e as { errcode?: number }).errcode
      if (code === undefined || !CORRUPT_CODES.has(code)) throw e
      report(e)
      removeDbFiles(file)
      db = openDb(file)
    }
  } catch (e) {
    report(e)
    return noopSpool()
  }

  let open = true
  let pruned = 0

  const insert = db.prepare('INSERT OR IGNORE INTO spool (id, body, created_at) VALUES (?, ?, ?)')
  const select = db.prepare(
    'SELECT id, body FROM spool WHERE claimed_at IS NULL ORDER BY created_at, rowid LIMIT ?',
  )
  const mark = db.prepare('UPDATE spool SET claimed_at = ? WHERE id = ?')
  const del = db.prepare('DELETE FROM spool WHERE id = ?')
  const unclaim = db.prepare('UPDATE spool SET claimed_at = NULL, attempts = attempts + 1 WHERE id = ?')
  const countAll = db.prepare('SELECT COUNT(*) AS n FROM spool')
  const sizes = db.prepare('SELECT id, length(body) AS size FROM spool ORDER BY created_at, rowid')
  const delOlder = db.prepare('DELETE FROM spool WHERE created_at < ?')

  /** Runs fn, converting any failure into an onError report and `fallback`. */
  function guard<T>(fallback: T, fn: (d: DatabaseSync) => T): T {
    if (!open) return fallback
    try {
      return fn(db)
    } catch (e) {
      report(e)
      return fallback
    }
  }

  function inTransaction<T>(d: DatabaseSync, fn: () => T): T {
    d.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      d.exec('COMMIT')
      return result
    } catch (e) {
      try { d.exec('ROLLBACK') } catch { /* connection already lost */ }
      throw e
    }
  }

  function pruneNow(d: DatabaseSync): number {
    return inTransaction(d, () => {
      let removed = Number(delOlder.run(Date.now() - maxAge).changes)
      const rows = sizes.all() as Array<{ id: string; size: number }>
      let total = rows.reduce((sum, r) => sum + r.size, 0)
      for (const r of rows) {
        if (total <= maxBytes) break
        del.run(r.id)
        total -= r.size
        removed++
      }
      pruned += removed
      return removed
    })
  }

  return {
    push(batch) {
      guard(undefined, (d) => {
        insert.run(batch.id, Buffer.from(JSON.stringify(batch)), Date.now())
        pruneNow(d)
      })
    },

    claim(n) {
      if (!Number.isInteger(n) || n <= 0) return []
      return guard([], (d) =>
        inTransaction(d, () => {
          const now = Date.now()
          const out: Array<{ id: string; batch: BatchFrame }> = []
          for (const row of select.all(n) as Array<{ id: string; body: Uint8Array }>) {
            try {
              const batch = JSON.parse(Buffer.from(row.body).toString('utf8')) as BatchFrame
              mark.run(now, row.id)
              out.push({ id: row.id, batch })
            } catch (e) {
              // An unreadable row would be re-selected forever; drop it and count the loss.
              del.run(row.id)
              pruned++
              report(e)
            }
          }
          return out
        }),
      )
    },

    ack(id) {
      guard(undefined, () => void del.run(id))
    },

    release(id) {
      guard(undefined, () => void unclaim.run(id))
    },

    prune: () => guard(0, pruneNow),

    count: () => guard(0, () => Number((countAll.get() as { n: number }).n)),

    prunedCount: () => pruned,

    available: () => open,

    close() {
      if (!open) return
      open = false
      try { db.close() } catch (e) { report(e) }
    },
  }
}
