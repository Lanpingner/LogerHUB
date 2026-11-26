import { DatabaseSync } from 'node:sqlite'

const DB_FILE = process.env.LOGGUBER_DB ?? '../ingest/data/logguber.db'

export interface Level {
  key: string
  label: string
}

export interface Settings {
  levels: Level[]
  globalIpAllowlist: string[]
  retentionDays: number
  configVersion: number
}

const DEFAULTS: Settings = {
  levels: [
    { key: 'service', label: 'Service' },
    { key: 'company_id', label: 'Company' },
    { key: 'user_id', label: 'User' },
  ],
  globalIpAllowlist: [],
  retentionDays: 30,
  configVersion: 1,
}

/** Read-only handle. The console never writes logs; it writes only config and keys. */
function open(readOnly = true) {
  return new DatabaseSync(DB_FILE, { readOnly })
}

function withDb<T>(fn: (db: DatabaseSync) => T, readOnly = true): T {
  const db = open(readOnly)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

export function settings(): Settings {
  try {
    return withDb((db) => {
      const row = db.prepare('SELECT json FROM settings WHERE id = 1').get() as { json: string } | undefined
      if (!row) return DEFAULTS
      return { ...DEFAULTS, ...(JSON.parse(row.json) as Partial<Settings>) }
    })
  } catch {
    return DEFAULTS
  }
}

export function saveSettings(next: Omit<Settings, 'configVersion'>): void {
  withDb((db) => {
    const current = settings()
    db.prepare('INSERT INTO settings (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json')
      .run(JSON.stringify({ ...next, configVersion: current.configVersion + 1 }))
  }, false)
}

export interface UsageRow {
  hour: number
  dims: Record<string, string>
  lines: number
  bytes: number
  requests: number
  /** Requests whose status was a number, and the 4xx/5xx counts within them.
   *  `classified: 0` with `requests > 0` means the hour predates these columns,
   *  which is a different thing from an hour with no failures. */
  classified: number
  clientErrors: number
  serverErrors: number
  errors: number
}

/** Reads rows at exactly one hierarchy depth, so no aggregation across children is needed. */
export function usage(opts: {
  depth: number
  sinceHours: number
  prefix?: Record<string, string>
}): UsageRow[] {
  const since = Math.floor(Date.now() / 1000) - opts.sinceHours * 3600
  return withDb((db) => {
    const rows = db
      .prepare(
        `SELECT hour, dims, lines, bytes, requests, classified, client_errors, server_errors, errors
           FROM usage_rollup WHERE depth = ? AND hour >= ? ORDER BY hour`,
      )
      .all(opts.depth, since) as {
      hour: number; dims: string; lines: number; bytes: number; requests: number
      classified: number; client_errors: number; server_errors: number; errors: number
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
        hour: r.hour, dims, lines: r.lines, bytes: r.bytes, requests: r.requests,
        classified: r.classified ?? 0, clientErrors: r.client_errors ?? 0, serverErrors: r.server_errors ?? 0,
        errors: r.errors,
      })
    }
    return out
  })
}

export interface Totals {
  label: string
  dims: Record<string, string>
  lines: number
  requests: number
  classified: number
  clientErrors: number
  serverErrors: number
  errors: number
  bytes: number
}

/** Collapses the time dimension: one row per distinct dimension set. */
export function totals(opts: { depth: number; sinceHours: number; prefix?: Record<string, string>; labelKey: string }): Totals[] {
  const rows = usage(opts)
  const byDims = new Map<string, Totals>()
  for (const r of rows) {
    const key = JSON.stringify(r.dims)
    let t = byDims.get(key)
    if (!t) {
      t = {
        label: r.dims[opts.labelKey] ?? 'unknown', dims: r.dims,
        lines: 0, requests: 0, classified: 0, clientErrors: 0, serverErrors: 0, errors: 0, bytes: 0,
      }
      byDims.set(key, t)
    }
    t.lines += r.lines
    t.requests += r.requests
    t.classified += r.classified
    t.clientErrors += r.clientErrors
    t.serverErrors += r.serverErrors
    t.errors += r.errors
    t.bytes += r.bytes
  }
  return [...byDims.values()].sort((a, b) => b.requests - a.requests || b.lines - a.lines)
}

export interface KeyRow {
  id: string
  name: string
  key_id: string
  service_scope: string[]
  env_scope: string[] | null
  ip_allowlist: string[]
  disabled_at: number | null
  last_used_at: number | null
  last_used_ip: string | null
}

export function keys(): KeyRow[] {
  const arr = (v: unknown): string[] => {
    try {
      const p = JSON.parse(String(v ?? '[]'))
      return Array.isArray(p) ? p.map(String) : []
    } catch {
      return []
    }
  }
  return withDb((db) => {
    const rows = db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as Record<string, unknown>[]
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      key_id: String(r.key_id),
      service_scope: arr(r.service_scope),
      env_scope: r.env_scope == null ? null : arr(r.env_scope),
      ip_allowlist: arr(r.ip_allowlist),
      disabled_at: r.disabled_at == null ? null : Number(r.disabled_at),
      last_used_at: r.last_used_at == null ? null : Number(r.last_used_at),
      last_used_ip: r.last_used_ip == null ? null : String(r.last_used_ip),
    }))
  })
}

export interface NewKey {
  id: string
  name: string
  key_id: string
  secret_hash: string
  service_scope: string[]
  env_scope: string[]
  ip_allowlist: string[]
}

/** The console writes the same row shape the seed CLI does; the gateway reads either. */
export function insertKey(k: NewKey): void {
  withDb((db) =>
    db
      .prepare(
        `INSERT INTO api_keys (id, name, key_id, secret_hash, service_scope, env_scope, ip_allowlist, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        k.id,
        k.name,
        k.key_id,
        k.secret_hash,
        JSON.stringify(k.service_scope),
        JSON.stringify(k.env_scope),
        JSON.stringify(k.ip_allowlist),
        Date.now(),
      ),
    false,
  )
}

export function disableKey(id: string): void {
  withDb((db) => db.prepare('UPDATE api_keys SET disabled_at = ? WHERE id = ?').run(Date.now(), id), false)
}

export function labels(): Record<string, Record<string, string>> {
  try {
    return withDb((db) => {
      const rows = db.prepare('SELECT dim_key, dim_value, display_name FROM dimension_labels').all() as {
        dim_key: string
        dim_value: string
        display_name: string
      }[]
      const out: Record<string, Record<string, string>> = {}
      for (const r of rows) {
        out[r.dim_key] ??= {}
        out[r.dim_key][r.dim_value] = r.display_name
      }
      return out
    })
  } catch {
    return {}
  }
}

export function putLabel(dimKey: string, dimValue: string, displayName: string): void {
  withDb(
    (db) =>
      db
        .prepare(
          `INSERT INTO dimension_labels (dim_key, dim_value, display_name) VALUES (?, ?, ?)
           ON CONFLICT(dim_key, dim_value) DO UPDATE SET display_name = excluded.display_name`,
        )
        .run(dimKey, dimValue, displayName),
    false,
  )
}

export interface IngestError {
  at: number
  key_id: string | null
  reason: string
  detail: string | null
}

export function recentErrors(): IngestError[] {
  try {
    return withDb((db) => {
      const rows = db
        .prepare('SELECT at, key_id, reason, detail FROM ingest_errors ORDER BY at DESC LIMIT 100')
        .all() as Record<string, unknown>[]
      return rows.map((r) => ({
        at: Number(r.at),
        key_id: r.key_id == null ? null : String(r.key_id),
        reason: String(r.reason),
        detail: r.detail == null ? null : String(r.detail),
      }))
    })
  } catch {
    return []
  }
}

export interface OperatorRow {
  id: string
  email: string
  password_hash: string
  /** 1 while the account still has the password it was created with. */
  must_change_password: number
}

export function operatorByEmail(email: string): OperatorRow | undefined {
  try {
    return withDb(
      (db) =>
        db
          .prepare('SELECT id, email, password_hash, must_change_password FROM operators WHERE email = ?')
          .get(email) as OperatorRow | undefined,
    )
  } catch {
    return undefined
  }
}

/** Clears the must-change flag as part of the same write, so the two cannot diverge. */
export function setOperatorPassword(email: string, hash: string): boolean {
  try {
    return withDb((db) => {
      const r = db
        .prepare('UPDATE operators SET password_hash = ?, must_change_password = 0 WHERE email = ?')
        .run(hash, email)
      return Number(r.changes) > 0
    }, false)
  } catch {
    return false
  }
}

export function knownServices(): string[] {
  const set = new Set<string>()
  for (const k of keys()) for (const s of k.service_scope) set.add(s)
  for (const t of totals({ depth: 1, sinceHours: 24 * 30, labelKey: 'service' })) {
    if (t.label && t.label !== 'unknown') set.add(t.label)
  }
  return [...set].sort()
}
