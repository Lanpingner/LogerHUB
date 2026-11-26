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
  /** Which structured kind this entry declared, when it declared one: `request`
   *  or `mcp`. The inspector reads it to decide what it is looking at. */
  kind?: string
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
  /** The address the gateway saw the batch arrive from. Observed server-side,
   *  never sent by the client, so it is the one field a sender cannot shape. */
  sourceIp?: string
  /** MCP tool call fields. Present only on a `kind: 'mcp'` row; `duration`
   *  above is shared with HTTP, which is why `duration:` spans both. */
  tool?: string
  mcpRole?: string
  mcpServer?: string
  callId?: string
  ok?: boolean
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
  const mcp = (payload?.mcp ?? {}) as Record<string, unknown>
  const dims = (payload?.dims ?? {}) as Record<string, string>
  const pick = (key: string) => meta[key] ?? dims[key]
  return {
    id: ns + ':' + (meta.request_id ?? Math.random().toString(36).slice(2, 8)),
    ts: Number(ns) / 1e6,
    level: stream.level ?? 'info',
    // Structured metadata first, the line copy as the fallback: Loki does not
    // return metadata from every query path.
    kind: meta.kind ?? (payload?.kind as string | undefined),
    application: stream.service ?? 'unknown',
    service: meta.service ?? stream.service ?? 'unknown',
    env: stream.env ?? '',
    method: meta.method ?? (http.method as string | undefined),
    path: (http.path as string | undefined) ?? meta.path,
    route: meta.route ?? (http.route as string | undefined),
    status: num(meta.status ?? http.status),
    duration: num(meta.duration_ms ?? http.duration_ms ?? mcp.duration_ms),
    tool: meta.tool ?? (mcp.tool as string | undefined),
    mcpRole: meta.role ?? (mcp.role as string | undefined),
    mcpServer: mcp.server as string | undefined,
    callId: meta.call_id ?? (mcp.call_id as string | undefined),
    // `ok` is a string in metadata and a boolean in the line; neither may be
    // read as "succeeded" when it is simply absent.
    ok: meta.ok !== undefined ? meta.ok === 'true' : typeof mcp.ok === 'boolean' ? mcp.ok : undefined,
    company: pick('company_id'),
    user: pick('user_id'),
    apiKey: pick('api_key_id'),
    requestId: pick('request_id') ?? (http.request_id as string | undefined),
    traceId: pick('trace_id'),
    instance: pick('instance'),
    // Structured metadata first; the line copy is the fallback, because Loki
    // does not return metadata from every query path.
    sourceIp: meta.source_ip ?? (payload?._source_ip as string | undefined),
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
  /** Null when no request in the range carried a numeric status, which is the
   *  case for every hour recorded before the status columns existed. A rate of
   *  100% would be a claim the data cannot support. */
  successRate: number | null
  clientErrorRate: number | null
  serverErrorRate: number | null
  /** Requests the rates above are computed from. Smaller than `requests` while
   *  the range still contains hours from before the columns were added. */
  classified: number
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

  // Counted from HTTP status, not from log level. The old proxy — error-level
  // lines over all lines — called a 500 logged at info a success, and could not
  // distinguish a client's bad request from the server failing.
  const classified = byApp.reduce((a, r) => a + r.classified, 0)
  const clientErrors = byApp.reduce((a, r) => a + r.clientErrors, 0)
  const serverErrors = byApp.reduce((a, r) => a + r.serverErrors, 0)

  return {
    requests,
    perSecond: requests / Math.max(1, minutes * 60),
    successRate: classified ? (classified - clientErrors - serverErrors) / classified : null,
    clientErrorRate: classified ? clientErrors / classified : null,
    serverErrorRate: classified ? serverErrors / classified : null,
    classified,
    lines,
    errors,
    bytes,
    applications: byApp.length,
    buckets,
    byApplication: byApp.map((r) => ({ name: r.label, requests: r.requests || r.lines, errors: r.errors })),
    topClients: clients.slice(0, 12).map((r) => ({ name: r.label, requests: r.requests || r.lines, errors: r.errors })),
  }
}

/* ---------------------------------------------------------------------------
 * Environment comparison.
 *
 * Every other aggregate panel in this console is computed from a capped sample
 * of log lines, which makes it a statement about the newest N lines rather than
 * about the range. These numbers are different: `count_over_time` is evaluated
 * by Loki across the whole range, so they are exact. The cost is one query per
 * figure instead of one shared sample, which is affordable here because the
 * result is a handful of numbers rather than a list of rows.
 *
 * `env` is an indexed Loki label, so this needs nothing recorded that is not
 * already there — unlike the usage rollup, whose dimensions do not include it.
 * ------------------------------------------------------------------------- */

interface LokiVector {
  metric: Record<string, string>
  value: [number, string]
}

/** LogQL duration for a window given in minutes. Loki accepts h/m suffixes; a
 *  fractional hour would be rejected, so minutes are kept below the hour. */
function logqlWindow(minutes: number): string {
  if (minutes % 60 === 0) return minutes / 60 + 'h'
  return Math.max(1, Math.round(minutes)) + 'm'
}

/** One instant metric query. Returns [] on any failure: an environments table
 *  missing a column is better than a page that will not render. */
async function instantMetric(query: string, minutes: number): Promise<LokiVector[]> {
  const url =
    LOKI + '/loki/api/v1/query?query=' + encodeURIComponent(query) +
    '&time=' + Date.now() * 1e6
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return []
    const body = (await res.json()) as { data?: { result?: LokiVector[] } }
    return body.data?.result ?? []
  } catch {
    return []
  }
}

export interface EnvRow {
  env: string
  lines: number
  errors: number
  services: { service: string; lines: number }[]
}

export interface EnvOverview {
  rows: EnvRow[]
  /** Environments the gateway knows a key is scoped to but which have sent
   *  nothing in this range. Listed so a silent environment is visible as
   *  silent rather than simply absent. */
  silent: string[]
  tookMs: number
}

export async function environments(minutes: number): Promise<EnvOverview> {
  const started = Date.now()
  const window = logqlWindow(minutes)
  const all = '{service=~".+"}'

  const [totals, errors, perService, known] = await Promise.all([
    instantMetric('sum by (env) (count_over_time(' + all + '[' + window + ']))', minutes),
    instantMetric(
      'sum by (env) (count_over_time({service=~".+", level=~"error|fatal"}[' + window + ']))',
      minutes,
    ),
    instantMetric('sum by (env, service) (count_over_time(' + all + '[' + window + ']))', minutes),
    labelValues('env'),
  ])

  const n = (v: LokiVector | undefined) => (v ? Number(v.value[1]) || 0 : 0)
  const errorByEnv = new Map(errors.map((r) => [r.metric.env, n(r)]))
  const servicesByEnv = new Map<string, { service: string; lines: number }[]>()
  for (const r of perService) {
    const list = servicesByEnv.get(r.metric.env) ?? []
    list.push({ service: r.metric.service, lines: n(r) })
    servicesByEnv.set(r.metric.env, list)
  }

  const rows: EnvRow[] = totals
    .map((r) => ({
      env: r.metric.env || 'unknown',
      lines: n(r),
      errors: errorByEnv.get(r.metric.env) ?? 0,
      services: (servicesByEnv.get(r.metric.env) ?? []).sort((a, b) => b.lines - a.lines),
    }))
    .sort((a, b) => b.lines - a.lines)

  const seen = new Set(rows.map((r) => r.env))
  return { rows, silent: known.filter((e) => !seen.has(e)).sort(), tookMs: Date.now() - started }
}

/** Distinct values Loki holds for a label. Used to tell "no traffic" apart from
 *  "no such environment". */
async function labelValues(label: string): Promise<string[]> {
  try {
    const res = await fetch(LOKI + '/loki/api/v1/label/' + encodeURIComponent(label) + '/values', {
      cache: 'no-store',
    })
    if (!res.ok) return []
    const body = (await res.json()) as { data?: string[] }
    return body.data ?? []
  } catch {
    return []
  }
}

/* ---------------------------------------------------------------------------
 * Instances and services.
 *
 * `service` and `env` are indexed Loki labels, so grouping by them is free.
 * `instance` is not: the client sends it as a dimension, which lives in the
 * line body. LogQL's json parser can lift it out — `| json
 * instance="dims.instance"` — which costs a parse per line but is evaluated
 * across the whole range, so a quiet instance still appears. A sampled count
 * could not do that, and "which replica went quiet?" is the question the page
 * exists to answer.
 * ------------------------------------------------------------------------- */

const ALL_STREAMS = '{service=~".+"}'
const WITH_INSTANCE = ALL_STREAMS + ' | json instance="dims.instance"'
const ERRORS_WITH_INSTANCE = '{service=~".+", level=~"error|fatal"} | json instance="dims.instance"'

interface LokiMatrix {
  metric: Record<string, string>
  values: [number, string][]
}

/** A metric query over the range, bucketed. Used where the shape of time
 *  matters rather than one total — here, to find the last bucket an instance
 *  reported in, which is the only way LogQL will give up a last-seen: there is
 *  no unwrap for an entry's own timestamp. */
async function rangeMetric(query: string, minutes: number, stepSeconds: number): Promise<LokiMatrix[]> {
  const end = Date.now()
  const start = end - minutes * 60_000
  const url =
    LOKI + '/loki/api/v1/query_range?query=' + encodeURIComponent(query) +
    '&start=' + start * 1e6 + '&end=' + end * 1e6 + '&step=' + stepSeconds
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return []
    const body = (await res.json()) as { data?: { result?: LokiMatrix[] } }
    return body.data?.result ?? []
  } catch {
    return []
  }
}

export interface InstanceRow {
  instance: string
  service: string
  env: string
  lines: number
  errors: number
  /** Milliseconds since the last bucket this instance reported in, or null when
   *  it could not be determined. The point of the page: a number that keeps
   *  climbing is a replica that stopped reporting. Resolution is the bucket
   *  width, so it is a "quiet for about this long", not a precise last-seen. */
  quietForMs: number | null
  /** The bucket width the figure above is accurate to, in milliseconds. */
  resolutionMs: number
}

export interface InstanceOverview {
  rows: InstanceRow[]
  tookMs: number
}

export async function instances(minutes: number): Promise<InstanceOverview> {
  const started = Date.now()
  const window = logqlWindow(minutes)

  // About two dozen buckets across the range, never finer than a minute. This
  // is the resolution of "quiet for", so it is reported alongside the figure.
  const step = Math.max(60, Math.round((minutes * 60) / 24))

  const [totals, errors, overTime] = await Promise.all([
    instantMetric('sum by (instance, service, env) (count_over_time(' + WITH_INSTANCE + '[' + window + ']))', minutes),
    instantMetric('sum by (instance) (count_over_time(' + ERRORS_WITH_INSTANCE + '[' + window + ']))', minutes),
    rangeMetric(
      'sum by (instance) (count_over_time(' + WITH_INSTANCE + '[' + step + 's]))',
      minutes,
      step,
    ),
  ])

  /** The timestamp of the newest bucket this instance actually reported in. */
  const lastBucket = new Map<string, number>()
  for (const series of overTime) {
    let last = 0
    for (const [t, v] of series.values) if (Number(v) > 0) last = Math.max(last, Number(t))
    if (last > 0) lastBucket.set(series.metric.instance, last)
  }

  const n = (v: { value: [number, string] } | undefined) => (v ? Number(v.value[1]) || 0 : 0)
  const errorByInstance = new Map(errors.map((r) => [r.metric.instance, n(r)]))
  const now = Date.now()

  const rows: InstanceRow[] = totals
    // An entry whose dims carry no instance parses to an empty label. Those are
    // lines from a client with `instance: false`, and grouping them under one
    // blank row would invent a replica that does not exist.
    .filter((r) => (r.metric.instance ?? '') !== '')
    .map((r) => {
      const seenSeconds = lastBucket.get(r.metric.instance) ?? 0
      return {
        instance: r.metric.instance,
        service: r.metric.service ?? 'unknown',
        env: r.metric.env ?? 'unknown',
        lines: n(r),
        errors: errorByInstance.get(r.metric.instance) ?? 0,
        quietForMs: seenSeconds > 0 ? Math.max(0, now - seenSeconds * 1000) : null,
        resolutionMs: step * 1000,
      }
    })
    .sort((a, b) => b.lines - a.lines)

  return { rows, tookMs: Date.now() - started }
}

export interface ServiceRow {
  service: string
  env: string
  lines: number
  errors: number
  instances: number
}

export async function services(minutes: number): Promise<{ rows: ServiceRow[]; tookMs: number }> {
  const started = Date.now()
  const window = logqlWindow(minutes)

  const [totals, errors, withInstance] = await Promise.all([
    instantMetric('sum by (service, env) (count_over_time(' + ALL_STREAMS + '[' + window + ']))', minutes),
    instantMetric(
      'sum by (service, env) (count_over_time({service=~".+", level=~"error|fatal"}[' + window + ']))',
      minutes,
    ),
    instantMetric(
      'sum by (service, env, instance) (count_over_time(' + WITH_INSTANCE + '[' + window + ']))',
      minutes,
    ),
  ])

  const n = (v: { value: [number, string] } | undefined) => (v ? Number(v.value[1]) || 0 : 0)
  const key = (service: string, env: string) => service + '\u0000' + env
  const errorBy = new Map(errors.map((r) => [key(r.metric.service, r.metric.env), n(r)]))
  const instanceCount = new Map<string, Set<string>>()
  for (const r of withInstance) {
    if ((r.metric.instance ?? '') === '') continue
    const k = key(r.metric.service, r.metric.env)
    const set = instanceCount.get(k) ?? new Set<string>()
    set.add(r.metric.instance)
    instanceCount.set(k, set)
  }

  const rows: ServiceRow[] = totals
    .map((r) => ({
      service: r.metric.service ?? 'unknown',
      env: r.metric.env ?? 'unknown',
      lines: n(r),
      errors: errorBy.get(key(r.metric.service, r.metric.env)) ?? 0,
      instances: instanceCount.get(key(r.metric.service, r.metric.env))?.size ?? 0,
    }))
    .sort((a, b) => b.lines - a.lines)

  return { rows, tookMs: Date.now() - started }
}
