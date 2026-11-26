import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface UsageRow {
  hour: number
  dims: Record<string, string>
  lines: number
  bytes: number
  requests: number
  mcp_calls: number
  /** Requests whose status was a number. The denominator for the two rates
   *  below, and the signal that distinguishes "no failures" from "no data":
   *  rows recorded before these columns existed read 0 here. */
  classified: number
  client_errors: number
  server_errors: number
  errors: number
}

export interface Totals {
  label: string
  dims: Record<string, string>
  lines: number
  requests: number
  errors: number
  bytes: number
}

export interface ApiKey {
  id: string
  name: string
  key_id: string
  secret_hash: string
  service_scope: string[]
  env_scope: string[] | null
  ip_allowlist: string[]
  disabled_at: number | null
}

export interface Settings {
  levels: { key: string; label: string }[]
  globalIpAllowlist: string[]
  retentionDays: number
  configVersion: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_id TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  service_scope TEXT NOT NULL,
  env_scope TEXT,
  ip_allowlist TEXT NOT NULL DEFAULT '[]',
  disabled_at INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  last_used_ip TEXT
);
CREATE TABLE IF NOT EXISTS usage_rollup (
  hour INTEGER NOT NULL,
  depth INTEGER NOT NULL,
  dims TEXT NOT NULL,
  lines INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  -- MCP tool calls, counted apart from the requests column: see rollup.ts.
  mcp_calls INTEGER NOT NULL DEFAULT 0,
  classified INTEGER NOT NULL DEFAULT 0,
  client_errors INTEGER NOT NULL DEFAULT 0,
  server_errors INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, depth, dims)
);
CREATE INDEX IF NOT EXISTS usage_depth_hour ON usage_rollup(depth, hour);
CREATE TABLE IF NOT EXISTS ingest_batches (
  key_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  -- NULL means claimed but not yet stored. A retry of an incomplete claim is a
  -- real retry, not a duplicate: treating it as a duplicate is how a transient
  -- Loki failure silently deleted the batch.
  completed_at INTEGER,
  PRIMARY KEY (key_id, batch_id)
);
CREATE INDEX IF NOT EXISTS batches_received ON ingest_batches(received_at);
CREATE TABLE IF NOT EXISTS dimension_labels (
  dim_key TEXT NOT NULL,
  dim_value TEXT NOT NULL,
  display_name TEXT NOT NULL,
  PRIMARY KEY (dim_key, dim_value)
);
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- 1 while the account still has the password it was created with. The console
  -- serves nothing but the change-password screen until it is cleared.
  must_change_password INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ingest_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  key_id TEXT,
  reason TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS errors_at ON ingest_errors(at);
`

export const OVERFLOW_VALUE = '__overflow__'

/** Distinct dimension combinations kept per hour, per hierarchy depth. Above
 *  this, combinations fold into a single overflow row. Chosen so a year of a
 *  busy month still fits comfortably, while a client inventing a dimension value
 *  per request cannot grow the table without bound. */
export const MAX_ROLLUP_ROWS_PER_BUCKET = 2000

/** Replaces every dimension but the service with a sentinel. The service name is
 *  bounded by the key's scope, so keeping it tells the operator where the
 *  cardinality came from. */
export function overflowDims(dims: string): string {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(dims) as Record<string, unknown>
  } catch {
    return dims
  }
  if (!parsed || typeof parsed !== 'object') return dims
  const out: Record<string, string> = Object.create(null)
  for (const k of Object.keys(parsed).sort()) {
    out[k] = k === 'service' ? String(parsed[k] ?? 'unknown') : OVERFLOW_VALUE
  }
  return JSON.stringify(out)
}

const DEFAULT_SETTINGS: Settings = {
  levels: [
    { key: 'service', label: 'Service' },
    { key: 'company_id', label: 'Company' },
    { key: 'user_id', label: 'User' },
  ],
  globalIpAllowlist: [],
  retentionDays: 30,
  configVersion: 1,
}

export function openStore(file: string) {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 2000')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)

  /**
   * Adds a column to a table that predates it. `CREATE TABLE IF NOT EXISTS`
   * does nothing to an existing table, so every column added after the first
   * release needs this. Idempotent by construction — it reads the table's
   * columns first — so it is safe on every start, and `ADD COLUMN` with a
   * `NOT NULL DEFAULT` rewrites no rows: existing history keeps every counter
   * it had and reads the default for the new one, which is the truth.
   */
  const addColumn = (table: string, column: string, definition: string): void => {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      if (cols.length === 0 || cols.some((c) => c.name === column)) return
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    } catch {
      // A table we cannot inspect is one we should not alter.
    }
  }

  // Usage gained a counter for MCP tool calls. In place: this table is the
  // operator's only record of what has been sent, and rebuilding it would
  // throw away every hour of history.
  addColumn('usage_rollup', 'mcp_calls', 'INTEGER NOT NULL DEFAULT 0')
  // Usage gained HTTP status classes, so a success rate can be a success rate
  // rather than "lines not logged at error level". Same in-place reasoning.
  addColumn('usage_rollup', 'classified', 'INTEGER NOT NULL DEFAULT 0')
  addColumn('usage_rollup', 'client_errors', 'INTEGER NOT NULL DEFAULT 0')
  addColumn('usage_rollup', 'server_errors', 'INTEGER NOT NULL DEFAULT 0')
  // Operators gained `must_change_password`. Also in place: it is the only
  // record of who can log in.
  addColumn('operators', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0')

  // The dedupe ledger gained `completed_at` and a per-key primary key. It holds
  // at most 24 hours of ids and nothing reads it for history, so rebuilding is
  // safe and simpler than an in-place migration.
  try {
    const cols = db.prepare('PRAGMA table_info(ingest_batches)').all() as { name: string }[]
    if (cols.length && !cols.some((c) => c.name === 'completed_at')) {
      db.exec('DROP TABLE ingest_batches')
      db.exec(SCHEMA)
    }
  } catch {
    // A store we cannot inspect is one we should not silently rewrite.
  }

  const st = {
    keyByKeyId: db.prepare('SELECT * FROM api_keys WHERE key_id = ?'),
    touchKey: db.prepare('UPDATE api_keys SET last_used_at = ?, last_used_ip = ? WHERE id = ?'),
    settings: db.prepare('SELECT json FROM settings WHERE id = 1'),
    putSettings: db.prepare(
      'INSERT INTO settings (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json',
    ),
    claimBatch: db.prepare('INSERT INTO ingest_batches (key_id, batch_id, received_at) VALUES (?, ?, ?)'),
    batchState: db.prepare('SELECT completed_at FROM ingest_batches WHERE key_id = ? AND batch_id = ?'),
    completeBatch: db.prepare('UPDATE ingest_batches SET completed_at = ? WHERE key_id = ? AND batch_id = ?'),
    releaseBatch: db.prepare('DELETE FROM ingest_batches WHERE key_id = ? AND batch_id = ? AND completed_at IS NULL'),
    pruneStaleClaims: db.prepare('DELETE FROM ingest_batches WHERE completed_at IS NULL AND received_at < ?'),
    pruneErrorsByAge: db.prepare('DELETE FROM ingest_errors WHERE at < ?'),
    pruneErrorsByCount: db.prepare(
      'DELETE FROM ingest_errors WHERE id NOT IN (SELECT id FROM ingest_errors ORDER BY at DESC LIMIT ?)',
    ),
    rollup: db.prepare(`
      INSERT INTO usage_rollup
        (hour, depth, dims, lines, bytes, requests, mcp_calls, classified, client_errors, server_errors, errors)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hour, depth, dims) DO UPDATE SET
        lines = lines + excluded.lines,
        bytes = bytes + excluded.bytes,
        requests = requests + excluded.requests,
        mcp_calls = mcp_calls + excluded.mcp_calls,
        classified = classified + excluded.classified,
        client_errors = client_errors + excluded.client_errors,
        server_errors = server_errors + excluded.server_errors,
        errors = errors + excluded.errors`),
    logError: db.prepare('INSERT INTO ingest_errors (at, key_id, reason, detail) VALUES (?, ?, ?, ?)'),
    countRollup: db.prepare('SELECT COUNT(*) AS n FROM usage_rollup WHERE hour = ? AND depth = ?'),
    hasRollup: db.prepare('SELECT 1 FROM usage_rollup WHERE hour = ? AND depth = ? AND dims = ? LIMIT 1'),
    pruneBatches: db.prepare('DELETE FROM ingest_batches WHERE received_at < ?'),
    allKeys: db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC'),
    insertKey: db.prepare(`INSERT INTO api_keys
      (id, name, key_id, secret_hash, service_scope, env_scope, ip_allowlist, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    disableKey: db.prepare('UPDATE api_keys SET disabled_at = ? WHERE id = ?'),
    labels: db.prepare('SELECT * FROM dimension_labels'),
    putLabel: db.prepare(`INSERT INTO dimension_labels (dim_key, dim_value, display_name) VALUES (?, ?, ?)
      ON CONFLICT(dim_key, dim_value) DO UPDATE SET display_name = excluded.display_name`),
    recentErrors: db.prepare('SELECT * FROM ingest_errors ORDER BY at DESC LIMIT 100'),
    operatorByEmail: db.prepare('SELECT * FROM operators WHERE email = ?'),
    usageAtDepth: db.prepare(
      `SELECT hour, dims, lines, bytes, requests, mcp_calls, classified, client_errors, server_errors, errors
         FROM usage_rollup WHERE depth = ? AND hour >= ? ORDER BY hour`,
    ),
    insertOperator: db.prepare(
      'INSERT INTO operators (id, email, password_hash, created_at, must_change_password) VALUES (?, ?, ?, ?, ?)',
    ),
    countOperators: db.prepare('SELECT COUNT(*) AS n FROM operators'),
    setPassword: db.prepare(
      'UPDATE operators SET password_hash = ?, must_change_password = 0 WHERE email = ?',
    ),
  }

  let rolledUpOverflow = 0

  function settings(): Settings {
    const row = st.settings.get() as { json: string } | undefined
    if (!row) return DEFAULT_SETTINGS
    try {
      return { ...DEFAULT_SETTINGS, ...(JSON.parse(row.json) as Partial<Settings>) }
    } catch {
      return DEFAULT_SETTINGS
    }
  }

  function parseKey(row: Record<string, unknown>): ApiKey {
    const arr = (v: unknown): string[] => {
      try {
        const p = JSON.parse(String(v ?? '[]'))
        return Array.isArray(p) ? p.map(String) : []
      } catch {
        return []
      }
    }
    return {
      id: String(row.id),
      name: String(row.name),
      key_id: String(row.key_id),
      secret_hash: String(row.secret_hash),
      service_scope: arr(row.service_scope),
      env_scope: row.env_scope == null ? null : arr(row.env_scope),
      ip_allowlist: arr(row.ip_allowlist),
      disabled_at: row.disabled_at == null ? null : Number(row.disabled_at),
    }
  }

  return {
    db,
    settings,
    saveSettings(next: Settings) {
      st.putSettings.run(JSON.stringify({ ...next, configVersion: next.configVersion + 1 }))
    },
    keyByKeyId(keyId: string): ApiKey | undefined {
      const row = st.keyByKeyId.get(keyId) as Record<string, unknown> | undefined
      return row ? parseKey(row) : undefined
    },
    touchKey(id: string, ip: string) {
      st.touchKey.run(Date.now(), ip, id)
    },
    /**
     * Claims a batch id for this key. Returns:
     *   'new'       — proceed and store it
     *   'retry'     — a previous attempt claimed it but never completed, so
     *                 storing it again is correct, not a duplicate
     *   'duplicate' — already stored; ack without doing the work again
     *
     * The dedupe namespace is per key, so one tenant cannot block another
     * tenant's id by claiming it first.
     */
    claimBatch(batchId: string, keyId: string): 'new' | 'retry' | 'duplicate' {
      try {
        st.claimBatch.run(keyId, batchId, Date.now())
        return 'new'
      } catch {
        const row = st.batchState.get(keyId, batchId) as { completed_at: number | null } | undefined
        return row && row.completed_at != null ? 'duplicate' : 'retry'
      }
    },
    /** Marks a claim as stored. Only after this does a retry become a duplicate. */
    completeBatch(batchId: string, keyId: string): void {
      try { st.completeBatch.run(Date.now(), keyId, batchId) } catch {}
    },
    /** Gives the id back after a failure, so the client's retry is handled for real. */
    releaseBatch(batchId: string, keyId: string): void {
      try { st.releaseBatch.run(keyId, batchId) } catch {}
    },
    rollup(rows: {
      hour: number; depth: number; dims: string; lines: number; bytes: number; requests: number
      mcp_calls: number; classified: number; client_errors: number; server_errors: number; errors: number
    }[]) {
      const tx = db.prepare('BEGIN IMMEDIATE')
      tx.run()
      try {
        // Counted once per (hour, depth) and then kept in step by hand: a COUNT
        // per row would be a query per log line at write time.
        const counts = new Map<string, number>()
        let folded = 0
        for (const r of rows) {
          const bucket = r.hour + '\u0000' + r.depth
          let n = counts.get(bucket)
          if (n === undefined) {
            n = Number((st.countRollup.get(r.hour, r.depth) as { n: number } | undefined)?.n ?? 0)
            counts.set(bucket, n)
          }
          let dims = r.dims
          if (n >= MAX_ROLLUP_ROWS_PER_BUCKET && !st.hasRollup.get(r.hour, r.depth, r.dims)) {
            // The ceiling exists because dimension values come from the client:
            // a caller sending a unique company id per request would otherwise
            // write a row per request. Folding keeps the totals honest — the
            // traffic is still counted — and loses only the breakdown.
            dims = overflowDims(r.dims)
            folded++
          } else if (!st.hasRollup.get(r.hour, r.depth, r.dims)) {
            counts.set(bucket, n + 1)
          }
          st.rollup.run(
            r.hour, r.depth, dims, r.lines, r.bytes, r.requests,
            r.mcp_calls, r.classified, r.client_errors, r.server_errors, r.errors,
          )
        }
        db.prepare('COMMIT').run()
        if (folded > 0) rolledUpOverflow = folded
      } catch (e) {
        try { db.prepare('ROLLBACK').run() } catch {}
        throw e
      }
    },
    /** How many rows the last rollup folded into the overflow bucket, for the
     *  caller to record once rather than per row. */
    takeOverflowCount(): number {
      const n = rolledUpOverflow
      rolledUpOverflow = 0
      return n
    },
    /** `detail` is attacker-influenced, so it is truncated before it is stored. */
    logError(keyId: string | null, reason: string, detail?: string) {
      const trimmed = detail == null ? null : String(detail).slice(0, 512)
      try { st.logError.run(Date.now(), keyId, String(reason).slice(0, 64), trimmed) } catch {}
    },
    prune() {
      const now = Date.now()
      try { st.pruneBatches.run(now - 24 * 60 * 60 * 1000) } catch {}
      // A claim that never completed is dead after an hour; the client has long
      // since retried or spooled it.
      try { st.pruneStaleClaims.run(now - 60 * 60 * 1000) } catch {}
      // Every rejected batch writes an error row, so this table is as
      // attacker-driven as the traffic. Bound it by age and by row count.
      try { st.pruneErrorsByAge.run(now - 14 * 24 * 60 * 60 * 1000) } catch {}
      try { st.pruneErrorsByCount.run(5000) } catch {}
    },
    listKeys: () => (st.allKeys.all() as Record<string, unknown>[]).map(parseKey),
    insertKey: (k: Omit<ApiKey, 'disabled_at'>) =>
      st.insertKey.run(k.id, k.name, k.key_id, k.secret_hash, JSON.stringify(k.service_scope),
        k.env_scope ? JSON.stringify(k.env_scope) : null, JSON.stringify(k.ip_allowlist), Date.now()),
    disableKey: (id: string) => st.disableKey.run(Date.now(), id),
    labels: () => st.labels.all() as { dim_key: string; dim_value: string; display_name: string }[],
    putLabel: (k: string, v: string, name: string) => st.putLabel.run(k, v, name),
    recentErrors: () => st.recentErrors.all() as Record<string, unknown>[],
    operatorByEmail: (email: string) => st.operatorByEmail.get(email) as Record<string, unknown> | undefined,
    insertOperator: (id: string, email: string, hash: string, mustChange = false) =>
      st.insertOperator.run(id, email, hash, Date.now(), mustChange ? 1 : 0),
    operatorCount: (): number => Number((st.countOperators.get() as { n: number } | undefined)?.n ?? 0),
    setOperatorPassword: (email: string, hash: string) => st.setPassword.run(hash, email),
    /** Rows at exactly one hierarchy depth, so no aggregation across children. */
    usage(opts: { depth: number; sinceHours: number; prefix?: Record<string, string> }): UsageRow[] {
      const since = Math.floor(Date.now() / 1000) - opts.sinceHours * 3600
      const rows = st.usageAtDepth.all(opts.depth, since) as {
        hour: number
        dims: string
        lines: number
        bytes: number
        requests: number
        mcp_calls: number
        classified: number
        client_errors: number
        server_errors: number
        errors: number
      }[]
      const out: UsageRow[] = []
      for (const r of rows) {
        let dims: Record<string, string>
        try {
          dims = JSON.parse(r.dims) as Record<string, string>
        } catch {
          continue
        }
        if (opts.prefix) {
          let ok = true
          for (const [k, v] of Object.entries(opts.prefix)) {
            if (dims[k] !== v) {
              ok = false
              break
            }
          }
          if (!ok) continue
        }
        out.push({
          hour: r.hour, dims, lines: r.lines, bytes: r.bytes,
          requests: r.requests, mcp_calls: r.mcp_calls,
          classified: r.classified, client_errors: r.client_errors, server_errors: r.server_errors,
          errors: r.errors,
        })
      }
      return out
    },
    close: () => db.close(),
  }
}

export type Store = ReturnType<typeof openStore>
