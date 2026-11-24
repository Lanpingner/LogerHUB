import { redirect } from 'next/navigation'
import { currentOperator } from '../../lib/auth'
import { labels, settings, totals, usage } from '../../lib/store'

const RANGES = [
  { h: 24, label: '24 hours' },
  { h: 24 * 7, label: '7 days' },
  { h: 24 * 30, label: '30 days' },
  { h: 24 * 90, label: '90 days' },
]

type Query = Record<string, string | string[] | undefined>

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

function bytes(n: number): string {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB'
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
}

export default async function UsagePage({ searchParams }: { searchParams: Promise<Query> }) {
  if (!(await currentOperator())) redirect('/login')

  const q = await searchParams
  const one = (k: string) => {
    const v = q[k]
    return Array.isArray(v) ? v[0] : v
  }
  const cfg = settings()
  const names = labels()
  const hours = Number(one('hours')) || 24 * 7

  // The drill-down path is the prefix of the configured hierarchy the operator has
  // clicked into. Depth = how many levels deep we are reading.
  const prefix: Record<string, string> = {}
  for (const level of cfg.levels) {
    const v = one('p_' + level.key)
    if (!v) break
    prefix[level.key] = v
  }
  const depth = Math.min(Object.keys(prefix).length + 1, cfg.levels.length)
  const level = cfg.levels[depth - 1]
  const rows = totals({ depth, sinceHours: hours, prefix, labelKey: level.key })
  const series = usage({ depth: Math.max(1, Object.keys(prefix).length || 1), sinceHours: hours, prefix })

  // One bucket per hour so the sparkline shows real gaps rather than smoothing them away.
  const buckets = new Map<number, number>()
  for (const r of series) buckets.set(r.hour, (buckets.get(r.hour) ?? 0) + r.requests + r.lines)
  const points = [...buckets.entries()].sort((a, b) => a[0] - b[0])
  const peak = Math.max(1, ...points.map(([, v]) => v))

  const grand = rows.reduce(
    (a, r) => ({ lines: a.lines + r.lines, requests: a.requests + r.requests, errors: a.errors + r.errors, bytes: a.bytes + r.bytes }),
    { lines: 0, requests: 0, errors: 0, bytes: 0 },
  )
  const maxReq = Math.max(1, ...rows.map((r) => r.requests || r.lines))

  const href = (extra: Record<string, string>) => {
    const p = new URLSearchParams({ hours: String(hours) })
    for (const [k, v] of Object.entries({ ...Object.fromEntries(Object.entries(prefix).map(([k2, v2]) => ['p_' + k2, v2])), ...extra })) {
      p.set(k, v)
    }
    return '?' + p.toString()
  }
  const crumbHref = (upto: number) => {
    const p = new URLSearchParams({ hours: String(hours) })
    cfg.levels.slice(0, upto).forEach((l) => {
      const v = prefix[l.key]
      if (v) p.set('p_' + l.key, v)
    })
    return '?' + p.toString()
  }

  return (
    <>
      <h1>Usage</h1>
      <p className="hint">
        Counted at ingest and stored per hour, so these load instantly over long ranges and survive after the raw logs
        have aged out.
      </p>

      <div className="crumbs">
        <a href={crumbHref(0)}>All</a>
        {Object.entries(prefix).map(([k, v], i) => (
          <span key={k}>
            {' / '}
            <a href={crumbHref(i + 1)}>{names[k]?.[v] ?? v}</a>
          </span>
        ))}
        <span className="spacer" style={{ flex: 1 }} />
        <form method="get" style={{ display: 'flex', gap: 6 }}>
          {Object.entries(prefix).map(([k, v]) => (
            <input key={k} type="hidden" name={'p_' + k} value={v} />
          ))}
          <select name="hours" defaultValue={String(hours)}>
            {RANGES.map((r) => (
              <option key={r.h} value={r.h}>
                {r.label}
              </option>
            ))}
          </select>
          <button type="submit">Apply</button>
        </form>
      </div>

      <div className="panel" style={{ marginBottom: 18 }}>
        <div className="row" style={{ gap: 28, marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>Requests</div>
            <div style={{ fontSize: 22, fontVariantNumeric: 'tabular-nums' }}>{fmt(grand.requests)}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>Log lines</div>
            <div style={{ fontSize: 22, fontVariantNumeric: 'tabular-nums' }}>{fmt(grand.lines)}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>Errors</div>
            <div style={{ fontSize: 22, fontVariantNumeric: 'tabular-nums', color: grand.errors ? 'var(--err)' : undefined }}>
              {fmt(grand.errors)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>Volume</div>
            <div style={{ fontSize: 22, fontVariantNumeric: 'tabular-nums' }}>{bytes(grand.bytes)}</div>
          </div>
        </div>
        {points.length ? (
          <div className="spark" title="activity per hour">
            {points.map(([h, v]) => (
              <i key={h} style={{ height: Math.max(2, Math.round((v / peak) * 46)) + 'px' }} />
            ))}
          </div>
        ) : null}
      </div>

      <h2>
        By {level.label}
        {depth < cfg.levels.length ? <span style={{ color: 'var(--muted)', fontWeight: 400 }}> — click a row to drill in</span> : null}
      </h2>

      {rows.length === 0 ? (
        <div className="empty">Nothing recorded in this range yet.</div>
      ) : (
        <div className="bars">
          {rows.map((r) => {
            const display = names[level.key]?.[r.label] ?? r.label
            const canDrill = depth < cfg.levels.length && r.label !== 'unknown'
            const width = Math.round(((r.requests || r.lines) / maxReq) * 100)
            return (
              <div className="bar" key={JSON.stringify(r.dims)}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {canDrill ? <a href={href({ ['p_' + level.key]: r.label })}>{display}</a> : display}
                  {display !== r.label ? (
                    <span className="mono" style={{ color: 'var(--muted)', fontSize: 11 }}>
                      {' '}
                      {r.label}
                    </span>
                  ) : null}
                </div>
                <div className="track">
                  <div className={'fill' + (r.errors && r.errors === r.lines ? ' err' : '')} style={{ width: width + '%' }} />
                </div>
                <div className="num mono" style={{ fontSize: 12 }}>
                  {fmt(r.requests || r.lines)}
                  {r.errors ? <span style={{ color: 'var(--err)' }}> · {fmt(r.errors)}e</span> : null}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <h2>Detail</h2>
      <div className="panel" style={{ padding: 0, overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>{level.label}</th>
              <th className="num">Requests</th>
              <th className="num">Lines</th>
              <th className="num">Errors</th>
              <th className="num">Error rate</th>
              <th className="num">Volume</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={'t' + JSON.stringify(r.dims)}>
                <td className="mono">{names[level.key]?.[r.label] ?? r.label}</td>
                <td className="num mono">{r.requests.toLocaleString()}</td>
                <td className="num mono">{r.lines.toLocaleString()}</td>
                <td className="num mono">{r.errors.toLocaleString()}</td>
                <td className="num mono">{r.lines ? ((r.errors / r.lines) * 100).toFixed(1) + '%' : '—'}</td>
                <td className="num mono">{bytes(r.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
