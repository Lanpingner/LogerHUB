'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { clock } from '../../lib/format'

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
const MAX_ROWS = 400
const SPARK_BUCKETS = 48

export function Tail({ services, dimKeys }: { services: string[]; dimKeys: string[] }) {
  const [rows, setRows] = useState<Entry[]>([])
  const [paused, setPaused] = useState(false)
  const [state, setState] = useState<'connecting' | 'live' | 'lost'>('connecting')
  const [service, setService] = useState('')
  const [level, setLevel] = useState('')
  const [dims, setDims] = useState<Record<string, string>>({})
  const [rate, setRate] = useState<number[]>(() => Array(SPARK_BUCKETS).fill(0))
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const arrivals = useRef(0)

  // One bucket per second, so the strip shows arrival rate rather than a count.
  useEffect(() => {
    const t = setInterval(() => {
      setRate((prev) => [...prev.slice(1), arrivals.current])
      arrivals.current = 0
    }, 1000)
    return () => clearInterval(t)
  }, [])

  const query = useMemo(() => {
    const p = new URLSearchParams()
    if (service) p.set('services', service)
    if (level) p.set('levels', level)
    const active = Object.fromEntries(Object.entries(dims).filter(([, v]) => v))
    if (Object.keys(active).length) p.set('dims', JSON.stringify(active))
    return p.toString()
  }, [service, level, dims])

  useEffect(() => {
    const es = new EventSource('/api/live?' + query)
    es.onopen = () => setState('live')
    es.onerror = () => setState('lost')
    es.onmessage = (ev) => {
      arrivals.current++
      if (pausedRef.current) return
      try {
        const entry = JSON.parse(ev.data) as Entry
        setRows((prev) => {
          const next = [entry, ...prev]
          return next.length > MAX_ROWS ? next.slice(0, MAX_ROWS) : next
        })
      } catch {
        // A malformed frame is skipped rather than breaking the stream.
      }
    }
    return () => es.close()
  }, [query])

  const peak = Math.max(1, ...rate)
  const perSecond = rate.slice(-10).reduce((a, b) => a + b, 0) / 10

  return (
    <>
      <div className="controls">
        <label className="ctl">
          <span>Service</span>
          <select value={service} onChange={(e) => setService(e.target.value)}>
            <option value="">Any</option>
            {services.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="ctl">
          <span>Level</span>
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">Any</option>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        {dimKeys.map((k) => (
          <label className="ctl" key={k}>
            <span>{k}</span>
            <input
              value={dims[k] ?? ''}
              size={11}
              onChange={(e) => setDims((d) => ({ ...d, [k]: e.target.value }))}
            />
          </label>
        ))}
        <button className="quiet" type="button" onClick={() => setPaused((p) => !p)}>
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button className="quiet" type="button" onClick={() => setRows([])}>
          Clear
        </button>
        <span className="ctl" style={{ marginLeft: 'auto' }}>
          <span>Arriving</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* 48 seconds of arrival rate — the one thing a tail should show at a glance. */}
            <span style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 22 }} aria-hidden="true">
              {rate.map((v, i) => (
                <i
                  key={i}
                  style={{
                    display: 'block',
                    width: 3,
                    height: Math.max(1, Math.round((v / peak) * 22)),
                    background: v ? 'var(--s1)' : 'var(--rule)',
                    borderRadius: 1,
                  }}
                />
              ))}
            </span>
            <span className="mono" style={{ fontSize: 12, color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums' }}>
              {perSecond.toFixed(1)}/s
            </span>
            <span className={'pill ' + (state === 'live' ? (paused ? '' : 'live') : 'stopped')}>
              {state === 'live' ? (paused ? 'Paused' : 'Live') : state === 'connecting' ? 'Connecting' : 'Disconnected'}
            </span>
          </span>
        </span>
      </div>

      {state === 'lost' ? (
        <div className="alert">
          <b>The live stream dropped</b>
          <p>
            Your services keep logging and spool to disk while the gateway is unreachable, so nothing is lost — lines
            will replay once it is back.
          </p>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="blank">
          {state === 'live' ? (
            <>
              <b>Connected and waiting</b>
              Lines appear the moment the gateway accepts them.
            </>
          ) : (
            <>
              <b>Connecting to the gateway</b>
              This takes a moment on first load.
            </>
          )}
        </div>
      ) : (
        <div className="lines">
          {rows.map((e, i) => {
            const facets = Object.entries(e.dims ?? {}).filter(([, v]) => v)
            return (
              <div className="line" key={e.ts + ':' + i}>
                <span className="at">{clock(Date.parse(e.ts))}</span>
                <span className={'lvl ' + e.level}>{e.level}</span>
                <div className="body">
                  <div className="msg mono">{e.msg}</div>
                  <div className="facets mono">
                    <span>
                      service <b>{e.service}</b>
                    </span>
                    {e.env ? (
                      <span>
                        env <b>{e.env}</b>
                      </span>
                    ) : null}
                    {facets.map(([k, v]) => (
                      <span key={k}>
                        {k} <b>{v}</b>
                      </span>
                    ))}
                  </div>
                  {e.meta ? (
                    <details>
                      <summary>Show payload</summary>
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
