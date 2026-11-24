import type { LogLine } from '../lib/loki'

const INTERESTING = ['company_id', 'user_id', 'api_key_id', 'status', 'method', 'route', 'duration_ms']

function time(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    pad(d.getHours()) +
    ':' + pad(d.getMinutes()) +
    ':' + pad(d.getSeconds()) +
    '.' + pad(d.getMilliseconds(), 3) +
    '  ' + pad(d.getDate()) + '/' + pad(d.getMonth() + 1)
  )
}

export function LogLines({ lines }: { lines: LogLine[] }) {
  return (
    <div>
      {lines.map((l, i) => {
        const level = l.labels.level ?? 'info'
        const msg = typeof l.parsed?.msg === 'string' ? l.parsed.msg : l.line
        const hasDetail = l.parsed !== null && Object.keys(l.parsed).some((k) => k !== 'msg')
        const chips = [
          ['service', l.labels.service],
          ['env', l.labels.env],
          ...INTERESTING.map((k) => [k, l.metadata[k]] as const),
        ].filter(([, v]) => Boolean(v)) as [string, string][]

        return (
          <div className="logline" key={l.ts + ':' + i}>
            <span className="ts mono">{time(l.ts)}</span>
            <span className={'lvl ' + level}>{level}</span>
            <div>
              <div className="msg mono">{msg}</div>
              {chips.length ? (
                <div className="chips">
                  {chips.map(([k, v]) => (
                    <span className="chip mono" key={k}>
                      {k}={v}
                    </span>
                  ))}
                </div>
              ) : null}
              {hasDetail ? (
                <details>
                  <summary>payload</summary>
                  <pre className="mono">{JSON.stringify(l.parsed, null, 2)}</pre>
                </details>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}
