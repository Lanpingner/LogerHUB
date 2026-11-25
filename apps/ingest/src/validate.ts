import { KINDS, LEVELS, type Kind, type LogEntry } from '@logguber/shared'

// Loki rejects samples older than reject_old_samples_max_age (7d in deploy/loki.yaml);
// future samples are refused past its creation grace period, so they are clamped.
const MAX_PAST_MS = 7 * 24 * 60 * 60 * 1000
const MAX_MSG_BYTES = 8 * 1024
const MAX_DIMS = 16
const MAX_DIM_BYTES = 256
const MAX_META_BYTES = 32 * 1024

const levelSet = new Set<string>(LEVELS)
const kindSet = new Set<string>(KINDS)

/**
 * Everything a sender claims, reduced to what the gateway is willing to store.
 * Its own module rather than a function inside server.ts so it can be tested
 * without starting a gateway, opening a database and binding a port.
 */
export function validate(entries: unknown): { ok: LogEntry[]; rejected: number } {
  if (!Array.isArray(entries)) return { ok: [], rejected: 0 }
  const ok: LogEntry[] = []
  let rejected = 0
  const now = Date.now()
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') { rejected++; continue }
    const e = raw as Record<string, unknown>
    const msg = typeof e.msg === 'string' ? e.msg : ''
    if (!msg) { rejected++; continue }
    // Clamp rather than only validate: a future timestamp passes a window check
    // but is then refused by Loki, and a backdated one rewrites a usage hour the
    // operator has already read.
    const parsed = Date.parse(String(e.ts ?? ''))
    const usable = Number.isFinite(parsed) && now - parsed < MAX_PAST_MS
    const ts = new Date(usable ? Math.min(parsed, now) : now).toISOString()

    const level = levelSet.has(String(e.level)) ? (e.level as LogEntry['level']) : 'info'

    const dims: Record<string, string> = {}
    if (e.dims && typeof e.dims === 'object') {
      for (const [k, v] of Object.entries(e.dims as Record<string, unknown>)) {
        if (typeof v !== 'string' || !v) continue
        if (Object.keys(dims).length >= MAX_DIMS) break
        // Dimension values become usage_rollup primary keys, so an unbounded
        // value is an unbounded row.
        dims[k.slice(0, 64)] = v.length > MAX_DIM_BYTES ? v.slice(0, MAX_DIM_BYTES) : v
      }
    }

    const entry: LogEntry = { ts, level, msg: msg.length > MAX_MSG_BYTES ? msg.slice(0, MAX_MSG_BYTES) : msg, dims }
    // A closed set, shared with the client: an entry claiming any other kind is
    // stored without one rather than refused, because the line itself is still
    // worth keeping. Only a kind the gateway knows can move a usage counter.
    if (typeof e.kind === 'string' && kindSet.has(e.kind)) entry.kind = e.kind as Kind
    if (e.meta && typeof e.meta === 'object') {
      let meta: Record<string, unknown> | undefined
      try {
        const serialised = JSON.stringify(e.meta)
        if (serialised && serialised.length <= MAX_META_BYTES) meta = e.meta as Record<string, unknown>
      } catch {
        // A meta that will not serialise is dropped rather than carried.
      }
      if (meta) entry.meta = meta
      else rejected++
    }
    ok.push(entry)
  }
  return { ok, rejected }
}
