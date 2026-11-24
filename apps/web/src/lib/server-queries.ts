import { compile, parse } from '@logguber/shared'
import { keys, settings, totals, usage } from './store'

const LOKI = (process.env.LOKI_URL ?? 'http://localhost:3100').replace(/\/$/, '')

export interface LogRow {
  id: string
  ts: number
  level: string
  application: string
  service: string
  env: string
  method?: string
  path?: string
  route?: string
  status?: number
  duration?: number
  company?: string
  user?: string
  apiKey?: string
  requestId?: string
  traceId?: string
  instance?: string
  msg: string
  payload: Record<string, unknown> | null
}

interface LokiStream {
  stream: Record<string, string>
  values: [string, string, Record<string, string>?][]
}

function num(v: unknown): number | undefined {
  if (v == null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function toRow(stream: Record<string, string>, ns: string, line: string, meta: Record<string, string> = {}): LogRow {
  let payload: Record<string, unknown> | null = null
  let msg = line
  try {
    const parsed = JSON.parse(line)
    if (parsed && typeof parsed === 'object') {
      payload = parsed as Record<string, unknown>
      if (typeof payload.msg === 'string') msg = payload.msg
    }
  } catch {
    // A non-JSON line is shown raw.
  }
  const http = (payload?.http ?? {}) as Record<string, unknown>
  const dims = (payload?.dims ?? {}) as Record<string, string>
  const pick = (key: string) => meta[key] ?? dims[key]
  return {
    id: ns + ':' + (meta.request_id ?? Math.random().toString(36).slice(2, 8)),
    ts: Number(ns) / 1e6,
    level: stream.level ?? 'info',
    application: stream.service ?? 'unknown',
    service: meta.service ?? stream.service ?? 'unknown',
    env: stream.env ?? '',
    method: meta.method ?? (http.method as string | undefined),
    path: (http.path as string | undefined) ?? meta.path,
    route: meta.route ?? (http.route as string | undefined),
    status: num(meta.status ?? http.status),
    duration: num(meta.duration_ms ?? http.duration_ms),
    company: pick('company_id'),
    user: pick('user_id'),
    apiKey: pick('api_key_id'),
    requestId: pick('request_id') ?? (http.request_id as string | undefined),
    traceId: pick('trace_id'),
    instance: pick('instance'),
    msg,
    payload,
  }
}

export interface SearchOutcome {
  rows: LogRow[]
  logql: string
  issues: { message: string }[]
  error?: string
  tookMs: number
}

export async function searchLogs(opts: {
  q: string
  minutes: number
  limit?: number
  service?: string
  env?: string
  level?: string
}): Promise<SearchOutcome> {
  const started = Date.now()
  const { query, issues } = parse(opts.q)
  const { logql } = compile(query, { service: opts.service, env: opts.env, level: opts.level })
  if (issues.length) {
    return { rows: [], logql, issues, error: issues[0].message, tookMs: Date.now() - started }
  }

  const end = Date.now() * 1e6
  const start = (Date.now() - opts.minutes * 60_000) * 1e6
  const url =
    LOKI + '/loki/api/v1/query_range?query=' + encodeURIComponent(logql) +
    '&start=' + start + '&end=' + end +
    '&limit=' + (opts.limit ?? 500) + '&direction=backward'

  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 240)
      return { rows: [], logql, issues: [], error: 'Loki returned ' + res.status + '. ' + text, tookMs: Date.now() - started }
    }
    const body = (await res.json()) as { data?: { result?: LokiStream[] } }
    const rows: LogRow[] = []
    for (const s of body.data?.result ?? []) {
      for (const [ns, line, meta] of s.values) rows.push(toRow(s.stream, ns, line, meta))
    }
    rows.sort((a, b) => b.ts - a.ts)
    return { rows, logql, issues: [], tookMs: Date.now() - started }
  } catch (e) {
    return {
      rows: [],
      logql,
      issues: [],
      error: 'Could not reach Loki at ' + LOKI + '. ' + (e as Error).message,
      tookMs: Date.now() - started,
    }
  }
}

export interface Bucket {
  t: number
  total: number
  errors: number
}

/** Volume histogram from the usage counters rather than from Loki: these are
 *  pre-aggregated at ingest, so the histogram stays instant over long ranges. */
export function volume(minutes: number, service?: string): Bucket[] {
  const hours = Math.max(1, Math.ceil(minutes / 60))
  const rows = usage({ depth: 1, sinceHours: hours, prefix: service ? { service } : undefined })
  const perDay = hours > 24 * 8
  // Counters are stored on hour boundaries, so the buckets must align to the
  // same boundaries or nothing ever matches and the chart renders empty.
  const slot = (h: number) => (perDay ? Math.floor(h / 86400) * 86400 : Math.floor(h / 3600) * 3600)
  const acc = new Map<number, Bucket>()
  const now = Math.floor(Date.now() / 1000)
  const step = perDay ? 86400 : 3600
  for (let t = slot(now - hours * 3600); t <= now; t += step) {
    acc.set(slot(t), { t: slot(t) * 1000, total: 0, errors: 0 })
  }
  for (const r of rows) {
    const b = acc.get(slot(r.hour))
    if (!b) continue
    b.total += r.requests || r.lines
    b.errors += r.errors
  }
  return [...acc.values()].sort((a, b) => a.t - b.t)
}

/** For short ranges the hourly counters give one or two columns, which is
 *  useless as a shape. Under six hours, bucket the sampled lines by minute. */
export function bucketsFromRows(rows: LogRow[], minutes: number): Bucket[] {
  const stepMs = minutes <= 15 ? 30_000 : minutes <= 60 ? 60_000 : 300_000
  const now = Date.now()
  const acc = new Map<number, Bucket>()
  const from = Math.floor((now - minutes * 60_000) / stepMs) * stepMs
  for (let t = from; t <= now; t += stepMs) acc.set(t, { t, total: 0, errors: 0 })
  for (const r of rows) {
    const k = Math.floor(r.ts / stepMs) * stepMs
    const b = acc.get(k)
    if (!b) continue
    b.total++
    if (r.level === 'error' || r.level === 'fatal' || (r.status ?? 0) >= 500) b.errors++
  }
  return [...acc.values()].sort((a, b) => a.t - b.t)
}

export interface TreeService {
  name: string
  requests: number
  errors: number
  lastSeen: number | null
  health: 'ok' | 'warn' | 'bad' | 'idle'
}

export interface TreeApp {
  name: string
  services: TreeService[]
  requests: number
  errors: number
  health: 'ok' | 'warn' | 'bad' | 'idle'
}

export interface TreeEnv {
  name: string
  applications: TreeApp[]
}

function healthOf(requests: number, errors: number, lastSeen: number | null): TreeService['health'] {
  if (!requests && !lastSeen) return 'idle'
  const rate = requests ? errors / requests : 0
  if (rate >= 0.05) return 'bad'
  if (rate >= 0.01) return 'warn'
  return 'ok'
}

/** The application tree is derived from what has actually been received, plus
 *  the keys that exist — so a service that has never sent still appears. */
export function tree(minutes: number): TreeEnv[] {
  const hours = Math.max(1, Math.ceil(minutes / 60))
  const rows = totals({ depth: 1, sinceHours: hours, labelKey: 'service' })
  const lastUsed = new Map<string, number | null>()
  const envsByService = new Map<string, Set<string>>()

  for (const k of keys()) {
    for (const s of k.service_scope) {
      lastUsed.set(s, Math.max(lastUsed.get(s) ?? 0, k.last_used_at ?? 0) || null)
      const set = envsByService.get(s) ?? new Set<string>()
      for (const e of k.env_scope ?? ['production']) set.add(e)
      envsByService.set(s, set)
    }
  }
  for (const r of rows) if (!envsByService.has(r.label)) envsByService.set(r.label, new Set(['production']))

  const byEnv = new Map<string, TreeApp[]>()
  for (const [service, envs] of envsByService) {
    const stat = rows.find((r) => r.label === service)
    const requests = stat?.requests || stat?.lines || 0
    const errors = stat?.errors ?? 0
    const seen = lastUsed.get(service) ?? null
    const svc: TreeService = { name: service, requests, errors, lastSeen: seen, health: healthOf(requests, errors, seen) }
    for (const env of envs) {
      const list = byEnv.get(env) ?? []
      list.push({ name: service, services: [svc], requests, errors, health: svc.health })
      byEnv.set(env, list)
    }
  }

  return [...byEnv.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, applications]) => ({ name, applications: applications.sort((a, b) => b.requests - a.requests) }))
}

export interface Overview {
  requests: number
  perSecond: number
  successRate: number
  clientErrorRate: number
  serverErrorRate: number
  lines: number
  errors: number
  bytes: number
  applications: number
  buckets: Bucket[]
  byApplication: { name: string; requests: number; errors: number }[]
  topClients: { name: string; requests: number; errors: number }[]
}

export function overview(minutes: number): Overview {
  const hours = Math.max(1, Math.ceil(minutes / 60))
  const byApp = totals({ depth: 1, sinceHours: hours, labelKey: 'service' })
  const cfg = settings()
  const clientLevel = cfg.levels[1]?.key
  // Depth 2 holds one row per (service, client), so a client that calls several
  // services appears several times. Sum across services before ranking.
  const clientRows = clientLevel ? totals({ depth: 2, sinceHours: hours, labelKey: clientLevel }) : []
  const clientAcc = new Map<string, { requests: number; lines: number; errors: number }>()
  for (const r of clientRows) {
    const acc = clientAcc.get(r.label) ?? { requests: 0, lines: 0, errors: 0 }
    acc.requests += r.requests
    acc.lines += r.lines
    acc.errors += r.errors
    clientAcc.set(r.label, acc)
  }
  const clients = [...clientAcc.entries()]
    .map(([label, v]) => ({ label, ...v }))
    .sort((a, b) => b.requests - a.requests || b.lines - a.lines)

  const requests = byApp.reduce((a, r) => a + r.requests, 0)
  const lines = byApp.reduce((a, r) => a + r.lines, 0)
  const errors = byApp.reduce((a, r) => a + r.errors, 0)
  const bytes = byApp.reduce((a, r) => a + r.bytes, 0)
  const buckets = volume(minutes)

  return {
    requests,
    perSecond: requests / Math.max(1, minutes * 60),
    successRate: lines ? 1 - errors / lines : 1,
    // Without a status breakdown in the counters, warn-level lines stand in for
    // client errors and error-level for server errors. Stated, not implied.
    clientErrorRate: 0,
    serverErrorRate: lines ? errors / lines : 0,
    lines,
    errors,
    bytes,
    applications: byApp.length,
    buckets,
    byApplication: byApp.map((r) => ({ name: r.label, requests: r.requests || r.lines, errors: r.errors })),
    topClients: clients.slice(0, 12).map((r) => ({ name: r.label, requests: r.requests || r.lines, errors: r.errors })),
  }
}
