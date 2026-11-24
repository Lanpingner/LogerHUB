import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

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
  errors INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, depth, dims)
);
CREATE INDEX IF NOT EXISTS usage_depth_hour ON usage_rollup(depth, hour);
CREATE TABLE IF NOT EXISTS ingest_batches (
  batch_id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  received_at INTEGER NOT NULL
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
  created_at INTEGER NOT NULL
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

  const st = {
    keyByKeyId: db.prepare('SELECT * FROM api_keys WHERE key_id = ?'),
    touchKey: db.prepare('UPDATE api_keys SET last_used_at = ?, last_used_ip = ? WHERE id = ?'),
    settings: db.prepare('SELECT json FROM settings WHERE id = 1'),
    putSettings: db.prepare(
      'INSERT INTO settings (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json',
    ),
    seenBatch: db.prepare('INSERT INTO ingest_batches (batch_id, key_id, received_at) VALUES (?, ?, ?)'),
    rollup: db.prepare(`
      INSERT INTO usage_rollup (hour, depth, dims, lines, bytes, requests, errors)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hour, depth, dims) DO UPDATE SET
        lines = lines + excluded.lines,
        bytes = bytes + excluded.bytes,
        requests = requests + excluded.requests,
        errors = errors + excluded.errors`),
    logError: db.prepare('INSERT INTO ingest_errors (at, key_id, reason, detail) VALUES (?, ?, ?, ?)'),
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
    insertOperator: db.prepare('INSERT INTO operators (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)'),
  }

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
    /** Returns false when this batch id was already stored. */
    claimBatch(batchId: string, keyId: string): boolean {
      try {
        st.seenBatch.run(batchId, keyId, Date.now())
        return true
      } catch {
        return false
      }
    },
    rollup(rows: { hour: number; depth: number; dims: string; lines: number; bytes: number; requests: number; errors: number }[]) {
      const tx = db.prepare('BEGIN IMMEDIATE')
      tx.run()
      try {
        for (const r of rows) st.rollup.run(r.hour, r.depth, r.dims, r.lines, r.bytes, r.requests, r.errors)
        db.prepare('COMMIT').run()
      } catch (e) {
        try { db.prepare('ROLLBACK').run() } catch {}
        throw e
      }
    },
    logError(keyId: string | null, reason: string, detail?: string) {
      try { st.logError.run(Date.now(), keyId, reason, detail ?? null) } catch {}
    },
    prune() {
      try { st.pruneBatches.run(Date.now() - 24 * 60 * 60 * 1000) } catch {}
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
    insertOperator: (id: string, email: string, hash: string) => st.insertOperator.run(id, email, hash, Date.now()),
    close: () => db.close(),
  }
}

export type Store = ReturnType<typeof openStore>
