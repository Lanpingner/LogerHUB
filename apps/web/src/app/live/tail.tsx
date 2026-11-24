'use client'

import { useEffect, useRef, useState } from 'react'

interface Entry {
  ts: string
  level: string
  kind?: string
  msg: string
  service: string
  env: string
  dims?: Record<string, string>
  meta?: Record<string, unknown>
}

const LEVELS = ['debug', 'info', 'warn', 'error', 'fatal']
const MAX_ROWS = 500

function time(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3)
}

export function Tail({ services, dimKeys }: { services: string[]; dimKeys: string[] }) {
  const [rows, setRows] = useState<Entry[]>([])
  const [paused, setPaused] = useState(false)
  const [state, setState] = useState<'connecting' | 'live' | 'error'>('connecting')
  const [service, setService] = useState('')
  const [level, setLevel] = useState('')
  const [dims, setDims] = useState<Record<string, string>>({})
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    const params = new URLSearchParams()
    if (service) params.set('services', service)
    if (level) params.set('levels', level)
    const active = Object.fromEntries(Object.entries(dims).filter(([, v]) => v))
    if (Object.keys(active).length) params.set('dims', JSON.stringify(active))

    const es = new EventSource('/api/live?' + params.toString())
    es.onopen = () => setState('live')
    es.onerror = () => setState('error')
    es.onmessage = (ev) => {
      if (pausedRef.current) return
      try {
        const entry = JSON.parse(ev.data) as Entry
        setRows((prev) => {
          const next = [entry, ...prev]
          return next.length > MAX_ROWS ? next.slice(0, MAX_ROWS) : next
        })
      } catch {
        // ignore a malformed frame rather than breaking the stream
      }
    }
    return () => es.close()
  }, [service, level, dims])

  return (
    <>
      <div className="filters">
        <div className="field">
          <label htmlFor="svc">Service</label>
          <select id="svc" value={service} onChange={(e) => setService(e.target.value)}>
            <option value="">All</option>
            {services.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="lvl">Level</label>
          <select id="lvl" value={level} onChange={(e) => setLevel(e.target.value)}>
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
            <label htmlFor={'dim_' + k}>{k}</label>
            <input
              id={'dim_' + k}
              value={dims[k] ?? ''}
              size={12}
              onChange={(e) => setDims((d) => ({ ...d, [k]: e.target.value }))}
            />
          </div>
        ))}
        <button type="button" onClick={() => setPaused((p) => !p)}>
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button type="button" onClick={() => setRows([])}>
          Clear
        </button>
        <span style={{ color: state === 'error' ? 'var(--err)' : 'var(--muted)', fontSize: 12 }}>
          {state === 'live' ? (paused ? 'paused' : 'live') : state === 'connecting' ? 'connecting…' : 'disconnected'}
          {' · '}
          {rows.length} line{rows.length === 1 ? '' : 's'}
        </span>
      </div>

      {state === 'error' ? (
        <div className="banner">
          Lost the live stream. The gateway may be down — logs are still being spooled by your services and will arrive
          when it returns.
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="empty">
          {state === 'live'
            ? 'Connected and waiting. Lines appear here the moment the gateway accepts them.'
            : 'Connecting to the gateway…'}
        </div>
      ) : (
        <div>
          {rows.map((e, i) => {
            const chips = Object.entries(e.dims ?? {}).filter(([, v]) => v)
            return (
              <div className="logline" key={e.ts + ':' + i}>
                <span className="ts mono">{time(e.ts)}</span>
                <span className={'lvl ' + e.level}>{e.level}</span>
                <div>
                  <div className="msg mono">{e.msg}</div>
                  <div className="chips">
                    <span className="chip mono">{e.service}</span>
                    {e.env ? <span className="chip mono">{e.env}</span> : null}
                    {e.kind ? <span className="chip mono">{e.kind}</span> : null}
                    {chips.map(([k, v]) => (
                      <span className="chip mono" key={k}>
                        {k}={v}
                      </span>
                    ))}
                  </div>
                  {e.meta ? (
                    <details>
                      <summary>payload</summary>
                      <pre className="mono">{JSON.stringify(e.meta, null, 2)}</pre>
                    </details>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
