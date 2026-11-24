import { redirect } from 'next/navigation'
import { currentOperator } from '../lib/auth'
import { EMPTY_FILTERS, search, type SearchFilters } from '../lib/loki'
import { knownServices, settings } from '../lib/store'
import { LogLines } from './log-lines'

const LEVELS = ['debug', 'info', 'warn', 'error', 'fatal']
const RANGES = [
  { h: 1, label: 'Last hour' },
  { h: 6, label: 'Last 6 hours' },
  { h: 24, label: 'Last 24 hours' },
  { h: 24 * 7, label: 'Last 7 days' },
  { h: 24 * 30, label: 'Last 30 days' },
]

type Query = Record<string, string | string[] | undefined>

function filtersFrom(q: Query, dimKeys: string[]): SearchFilters {
  const one = (k: string) => {
    const v = q[k]
    return Array.isArray(v) ? v[0] : v
  }
  const many = (k: string) => {
    const v = one(k)
    return v ? v.split(',').filter(Boolean) : []
  }
  const dims: Record<string, string> = {}
  for (const k of dimKeys) {
    const v = one('d_' + k)
    if (v) dims[k] = v
  }
  const hours = Number(one('hours'))
  const limit = Number(one('limit'))
  return {
    ...EMPTY_FILTERS,
    services: many('services'),
    envs: many('envs'),
    levels: many('levels'),
    dims,
    text: one('text') ?? '',
    regex: one('regex') === '1',
    sinceHours: Number.isFinite(hours) && hours > 0 ? hours : 1,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 5000) : 200,
  }
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<Query> }) {
  if (!(await currentOperator())) redirect('/login')

  const q = await searchParams
  const cfg = settings()
  // `service` is a Loki label, so it is filtered in the stream selector, not as metadata.
  const dimKeys = cfg.levels.map((l) => l.key).filter((k) => k !== 'service')
  const filters = filtersFrom(q, dimKeys)
  const { lines, query, error } = await search(filters)
  const services = knownServices()

  return (
    <>
      <h1>Search</h1>

      <form className="filters" method="get">
        <div className="field">
          <label htmlFor="services">Service</label>
          <select id="services" name="services" defaultValue={filters.services[0] ?? ''}>
            <option value="">All</option>
            {services.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="envs">Env</label>
          <input id="envs" name="envs" placeholder="prod" defaultValue={filters.envs.join(',')} size={8} />
        </div>

        <div className="field">
          <label htmlFor="levels">Level</label>
          <select id="levels" name="levels" defaultValue={filters.levels[0] ?? ''}>
            <option value="">All</option>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>

        {dimKeys.map((k) => (
          <div className="field" key={k}>
            <label htmlFor={'d_' + k}>{cfg.levels.find((l) => l.key === k)?.label ?? k}</label>
            <input id={'d_' + k} name={'d_' + k} defaultValue={filters.dims[k] ?? ''} size={12} />
          </div>
        ))}

        <div className="field" style={{ flex: 1, minWidth: 220 }}>
          <label htmlFor="text">Contains</label>
          <input id="text" name="text" defaultValue={filters.text} placeholder="free text or regex" />
        </div>

        <div className="field">
          <label htmlFor="regex">Regex</label>
          <select id="regex" name="regex" defaultValue={filters.regex ? '1' : '0'}>
            <option value="0">off</option>
            <option value="1">on</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="hours">Range</label>
          <select id="hours" name="hours" defaultValue={String(filters.sinceHours)}>
            {RANGES.map((r) => (
              <option key={r.h} value={r.h}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        <button className="primary" type="submit">
          Search
        </button>
      </form>

      {error ? <div className="banner">{error}</div> : null}

      <details style={{ marginBottom: 12 }}>
        <summary style={{ color: 'var(--muted)', fontSize: 12, cursor: 'pointer' }}>LogQL</summary>
        <pre className="mono" style={{ background: 'var(--panel)', padding: 10, borderRadius: 6, overflowX: 'auto' }}>
          {query}
        </pre>
      </details>

      {lines.length === 0 && !error ? (
        <div className="empty">No lines matched. Widen the range or clear a filter.</div>
      ) : (
        <>
          <p className="hint">
            {lines.length} line{lines.length === 1 ? '' : 's'}
            {lines.length >= filters.limit ? ' (limit reached — narrow the range for more)' : ''}
          </p>
          <LogLines lines={lines} />
        </>
      )}
    </>
  )
}
