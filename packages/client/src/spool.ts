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
  /** A claim older than this (ms) is presumed abandoned and reclaimed. Default 60s. */
  staleClaimMs?: number
  /** How long a locked database may block the caller (ms). Default 250: a logger must not stall requests. */
  busyTimeoutMs?: number
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
const DEFAULT_STALE_CLAIM_MS = 60000
const DB_FILE = 'spool.db'
// SQLITE_CORRUPT and SQLITE_NOTADB, compared on the primary code so extended codes
// (e.g. SQLITE_CORRUPT_INDEX = 779) match too.
const CORRUPT_CODES = new Set([11, 26])
const DEFAULT_BUSY_TIMEOUT_MS = 250

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

const isCorrupt = (e: unknown): boolean => {
  const code = (e as { errcode?: number }).errcode
  return typeof code === 'number' && CORRUPT_CODES.has(code & 0xff)
}

/** Corrupt file, or a `spool` table whose shape our statements do not fit: start over. */
const isRecoverable = (e: unknown): boolean => isCorrupt(e) || (e as { schemaMismatch?: boolean }).schemaMismatch === true

function prepareAll(db: DatabaseSync) {
  return {
    insert: db.prepare('INSERT OR IGNORE INTO spool (id, body, created_at) VALUES (?, ?, ?)'),
    select: db.prepare('SELECT id, body FROM spool WHERE claimed_at IS NULL ORDER BY created_at, rowid LIMIT ?'),
    mark: db.prepare('UPDATE spool SET claimed_at = ? WHERE id = ?'),
    del: db.prepare('DELETE FROM spool WHERE id = ? RETURNING length(body) AS size'),
    unclaim: db.prepare(
      'UPDATE spool SET claimed_at = NULL, attempts = attempts + 1 WHERE id = ? AND claimed_at IS NOT NULL',
    ),
    reclaim: db.prepare(
      'UPDATE spool SET claimed_at = NULL, attempts = attempts + 1 WHERE claimed_at IS NOT NULL AND claimed_at < ?',
    ),
    countAll: db.prepare('SELECT COUNT(*) AS n FROM spool'),
    total: db.prepare('SELECT COALESCE(SUM(length(body)), 0) AS n FROM spool'),
    // Unclaimed rows are evicted first so an in-flight batch is only lost when the bound demands it.
    sizes: db.prepare(
      'SELECT id, length(body) AS size FROM spool ORDER BY (claimed_at IS NOT NULL), created_at, rowid',
    ),
    delOlder: db.prepare('DELETE FROM spool WHERE created_at < ? RETURNING length(body) AS size'),
  }
}

interface Handle {
  db: DatabaseSync
  st: ReturnType<typeof prepareAll>
  /** Running sum of stored body sizes, so push need not scan the table. */
  bytes: number
}

function connect(file: string, busyTimeoutMs: number): Handle {
  const db = new DatabaseSync(file)
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(`CREATE TABLE IF NOT EXISTS spool (
      id TEXT PRIMARY KEY,
      body BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_at INTEGER
    )`)
    db.exec('CREATE INDEX IF NOT EXISTS spool_created_at ON spool (created_at)')
    const st = prepareAll(db)
    return { db, st, bytes: Number((st.total.get() as { n: number }).n) }
  } catch (e) {
    try { db.close() } catch { /* already unusable */ }
    // Plain SQLITE_ERROR here ("no such column") means a `spool` table of another shape
    // already exists (older client, foreign file); callers start over on it.
    if (e instanceof Error && ((e as { errcode?: number }).errcode ?? 0) % 256 === 1) {
      Object.assign(e, { schemaMismatch: true })
    }
    throw e
  }
}

function removeDbFiles(file: string): void {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true })
}

export function createSpool(opts: SpoolOptions): Spool {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const maxAge = opts.maxAge ?? DEFAULT_MAX_AGE
  const staleClaimMs = opts.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS
  const busyMs = opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS
  const report = (e: unknown): void => {
    try { opts.onError?.(toError(e)) } catch { /* a throwing handler must not crash the host */ }
  }
  const file = path.join(opts.dir, DB_FILE)

  let h: Handle
  try {
    fs.mkdirSync(opts.dir, { recursive: true })
    try {
      h = connect(file, busyMs)
    } catch (e) {
      if (!isRecoverable(e)) throw e
      report(e)
      removeDbFiles(file)
      h = connect(file, busyMs)
    }
  } catch (e) {
    report(e)
    return noopSpool()
  }

  let open = true
  let unhealthy = false
  let pruned = 0

  /** Reopens over a fresh file after mid-life corruption. Rows in the damaged file are lost. */
  function recover(): boolean {
    try { h.db.close() } catch { /* already unusable */ }
    try {
      removeDbFiles(file)
      h = connect(file, busyMs)
      return true
    } catch (e) {
      report(e)
      return false
    }
  }

  /** Runs fn, converting any failure into an onError report and `fallback`. */
  function guard<T>(fallback: T, fn: (cur: Handle) => T): T {
    if (!open || unhealthy) return fallback
    try {
      return fn(h)
    } catch (e) {
      report(e)
      if (!isCorrupt(e)) return fallback
      if (!recover()) {
        unhealthy = true
        return fallback
      }
      try {
        return fn(h)
      } catch (e2) {
        report(e2)
        return fallback
      }
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

  /** Age and size pruning. Counters move only after the transaction commits. */
  function pruneNow(cur: Handle, keepId?: string): number {
    const { st } = cur
    const r = inTransaction(cur.db, () => {
      const old = st.delOlder.all(Date.now() - maxAge) as Array<{ size: number }>
      let removed = old.length
      let bytes = cur.bytes - old.reduce((sum, o) => sum + Number(o.size), 0)
      if (bytes > maxBytes) {
        // Full scan only when the running total says we are over; it also resyncs the total.
        const rows = st.sizes.all() as Array<{ id: string; size: number }>
        bytes = rows.reduce((sum, row) => sum + Number(row.size), 0)
        for (const row of rows) {
          if (bytes <= maxBytes) break
          if (row.id === keepId) continue
          st.del.get(row.id)
          bytes -= Number(row.size)
          removed++
        }
      }
      return { removed, bytes }
    })
    cur.bytes = r.bytes
    pruned += r.removed
    return r.removed
  }

  return {
    push(batch) {
      guard(undefined, (cur) => {
        const body = Buffer.from(JSON.stringify(batch))
        if (body.length > maxBytes) {
          // Storing it would mean evicting everything else and then itself.
          pruned++
          report(new Error(`spool: batch ${batch.id} (${body.length} bytes) exceeds maxBytes, dropped`))
          return
        }
        if (Number(cur.st.insert.run(batch.id, body, Date.now()).changes) > 0) cur.bytes += body.length
        pruneNow(cur, batch.id)
      })
    },

    claim(n) {
      if (!Number.isInteger(n) || n <= 0) return []
      return guard([], (cur) => {
        const { st } = cur
        const bad: unknown[] = []
        let freed = 0
        const out = inTransaction(cur.db, () => {
          const now = Date.now()
          // Rows claimed by a crashed (or very slow) worker go back in the queue.
          st.reclaim.run(now - staleClaimMs)
          const claimed: Array<{ id: string; batch: BatchFrame }> = []
          for (const row of st.select.all(n) as Array<{ id: string; body: Uint8Array }>) {
            let batch: BatchFrame
            try {
              batch = JSON.parse(Buffer.from(row.body).toString('utf8')) as BatchFrame
            } catch (e) {
              // An unreadable row would be re-selected forever; drop it and count the loss.
              const gone = st.del.get(row.id) as { size: number } | undefined
              freed += Number(gone?.size ?? 0)
              bad.push(e)
              continue
            }
            // Outside the parse try: a failing write must roll back, not delete a healthy row.
            st.mark.run(now, row.id)
            claimed.push({ id: row.id, batch })
          }
          return claimed
        })
        cur.bytes -= freed
        pruned += bad.length
        bad.forEach(report)
        return out
      })
    },

    ack(id) {
      guard(undefined, (cur) => {
        const gone = cur.st.del.get(id) as { size: number } | undefined
        if (gone) cur.bytes -= Number(gone.size)
      })
    },

    release(id) {
      guard(undefined, (cur) => void cur.st.unclaim.run(id))
    },

    prune: () => guard(0, (cur) => pruneNow(cur)),

    count: () => guard(0, (cur) => Number((cur.st.countAll.get() as { n: number }).n)),

    prunedCount: () => pruned,

    available: () => open && !unhealthy,

    close() {
      if (!open) return
      open = false
      try { h.db.close() } catch (e) { report(e) }
    },
  }
}
