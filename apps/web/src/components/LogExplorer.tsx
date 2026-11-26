'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download, Play, TerminalSquare, Table2 } from 'lucide-react'
import { useConsole } from '../store/console'
import { C, MONO } from '../lib/tokens'
import type { LogRow, SearchResponse } from '../lib/types'
import { QueryEditor } from './QueryEditor'
import { TrafficHistogram } from './TrafficHistogram'
import { LogDataGrid, RawLogStream } from './LogDataGrid'
import { RequestInspector } from './RequestInspector'
import { TimeRangeSelector } from './TimeRangeSelector'
import { Panel } from './Panel'
import { useStatusFacts } from './status-context'

const FACETS: { key: keyof LogRow; label: string }[] = [
  { key: 'application', label: 'Application' },
  { key: 'method', label: 'Method' },
  { key: 'status', label: 'Status' },
  { key: 'company', label: 'Company' },
  { key: 'env', label: 'Environment' },
  { key: 'level', label: 'Level' },
]

export function LogExplorer() {
  const { range, filters, patchFilters, rawMode, setRawMode, inspectorWidth, setInspectorWidth } = useConsole()
  const publish = useStatusFacts()
  const [draft, setDraft] = useState(filters.query)
  const [applied, setApplied] = useState(filters.query)
  const [selected, setSelected] = useState<LogRow | null>(null)
  // Stable, so the memoised inspector is not re-rendered by the stream.
  const clearSelected = useCallback(() => setSelected(null), [])
  const [limit, setLimit] = useState(500)

  const { data, isFetching, isError, error, refetch } = useQuery<SearchResponse>({
    queryKey: ['explorer', applied, range, limit, filters.service, filters.environment],
    queryFn: async () => {
      const p = new URLSearchParams({ q: applied, range, limit: String(limit) })
      if (filters.service) p.set('service', filters.service)
      if (filters.environment) p.set('env', filters.environment)
      const res = await fetch('/api/search?' + p.toString())
      if (!res.ok) throw new Error('Search failed with ' + res.status)
      return res.json()
    },
  })

  const rows = data?.rows ?? []

  const facets = useMemo(() => {
    return FACETS.map((f) => {
      const counts = new Map<string, number>()
      for (const r of rows) {
        const v = r[f.key]
        if (v == null || v === '') continue
        const key = String(v)
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      return {
        ...f,
        values: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
      }
    }).filter((f) => f.values.length)
  }, [rows])

  useEffect(() => {
    publish({ matching: rows.length, tookMs: data?.tookMs, connection: 'live' })
  }, [publish, rows.length, data?.tookMs])

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'logerhub-explorer.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const addTerm = (term: string) => {
    const next = (draft ? draft.trim() + ' ' : '') + term
    setDraft(next)
    setApplied(next)
    patchFilters({ query: next })
  }

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Box
        sx={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          px: 2,
          py: 1,
          borderBottom: '1px solid ' + C.border,
          background: C.panel,
          flexWrap: 'wrap',
        }}
      >
        <QueryEditor
          value={draft}
          onChange={(v) => {
            setDraft(v)
            patchFilters({ query: v })
          }}
          onRun={(v) => setApplied(v)}
          services={[...new Set(rows.map((r) => r.service))]}
          envs={[...new Set(rows.map((r) => r.env).filter(Boolean))]}
        />
        <Button onClick={() => setApplied(draft)} startIcon={<Play size={12} />} disabled={isFetching}>
          {isFetching ? 'Running' : 'Run'}
        </Button>
        <TimeRangeSelector />
        <Button onClick={() => setLimit((l) => (l >= 2000 ? 500 : l * 2))}>limit {limit}</Button>
        <Box sx={{ flex: 1 }} />
        <Tooltip title={rawMode ? 'Table view' : 'Raw output'}>
          <IconButton onClick={() => setRawMode(!rawMode)} aria-label="Toggle raw output">
            {rawMode ? <Table2 size={14} /> : <TerminalSquare size={14} />}
          </IconButton>
        </Tooltip>
        <Tooltip title="Export results as JSON">
          <IconButton onClick={exportJson} aria-label="Export">
            <Download size={14} />
          </IconButton>
        </Tooltip>
      </Box>

      {data?.error || isError ? (
        <Box sx={{ px: 2, py: 1, borderBottom: '1px solid ' + C.error, background: 'rgba(248,113,113,0.08)', fontSize: 11.5, color: C.error }}>
          {data?.error ?? (error as Error)?.message}
        </Box>
      ) : null}

      <Box sx={{ flex: 'none', borderBottom: '1px solid ' + C.border, background: C.panel, px: 1, pt: 1 }}>
        <Box sx={{ px: 1, fontSize: 10, color: C.muted }}>Volume over {range}</Box>
        <TrafficHistogram buckets={data?.buckets ?? []} height={76} />
      </Box>

      <Box sx={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <Box sx={{ width: 212, flex: 'none', borderRight: '1px solid ' + C.border, overflowY: 'auto', background: C.panel }}>
          <Box sx={{ px: 2, py: 1, fontSize: 10, letterSpacing: '0.08em', color: C.muted, fontWeight: 600 }}>
            FIELDS IN RESULTS
          </Box>
          {facets.length === 0 ? (
            <Box sx={{ px: 2, fontSize: 11, color: C.muted }}>Run a query to see field distributions.</Box>
          ) : (
            facets.map((f) => (
              <Box key={String(f.key)} sx={{ mb: 1.5 }}>
                <Box sx={{ px: 2, fontSize: 11, color: C.text2, mb: 0.5 }}>{f.label}</Box>
                {f.values.map(([value, count]) => (
                  <Box
                    key={value}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      const field =
                        f.key === 'application' ? 'app'
                        : f.key === 'env' ? 'env'
                        : f.key === 'company' ? 'company'
                        : String(f.key)
                      addTerm(field + ':' + value)
                    }}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1,
                      px: 2,
                      height: 20,
                      cursor: 'pointer',
                      '&:hover': { background: C.raised },
                    }}
                  >
                    <Box
                      sx={{
                        fontFamily: MONO,
                        fontSize: 10.5,
                        color: C.text,
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {value}
                    </Box>
                    <Box sx={{ fontFamily: MONO, fontSize: 10, color: C.muted }}>{count}</Box>
                  </Box>
                ))}
              </Box>
            ))
          )}
          {data?.logql ? (
            <Box sx={{ p: 2, borderTop: '1px solid ' + C.border, mt: 1 }}>
              <Box sx={{ fontSize: 10, color: C.muted, mb: 0.5 }}>Compiled LogQL</Box>
              <Box
                component="pre"
                sx={{
                  m: 0,
                  fontFamily: MONO,
                  fontSize: 10,
                  color: C.text2,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  lineHeight: 1.6,
                }}
              >
                {data.logql}
              </Box>
            </Box>
          ) : null}
        </Box>

        <Box sx={{ flex: 1, minWidth: 0 }}>
          {rawMode ? (
            <RawLogStream rows={rows} />
          ) : (
            <LogDataGrid rows={rows} selectedId={selected?.id} onSelect={setSelected} loading={isFetching} />
          )}
        </Box>

        {selected ? (
          <>
            <Box
              onPointerDown={(e) => {
                e.preventDefault()
                const move = (ev: PointerEvent) => setInspectorWidth(window.innerWidth - ev.clientX)
                const up = () => {
                  window.removeEventListener('pointermove', move)
                }
                window.addEventListener('pointermove', move)
                window.addEventListener('pointerup', up, { once: true })
              }}
              role="separator"
              aria-label="Resize inspector"
              sx={{ width: 4, cursor: 'col-resize', flex: 'none', background: C.border, '&:hover': { background: 'rgba(74,222,128,0.35)' } }}
            />
            <Box sx={{ width: inspectorWidth, flex: 'none', minWidth: 0 }}>
              <RequestInspector row={selected} onClose={clearSelected} />
            </Box>
          </>
        ) : null}
      </Box>
    </Box>
  )
}

/** Endpoints, grouped by normalised route rather than by individual resource id. */
export function Endpoints() {
  const { range, patchFilters } = useConsole()
  const publish = useStatusFacts()
  const { data, isFetching } = useQuery<SearchResponse>({
    queryKey: ['endpoints', range],
    queryFn: async () => {
      const res = await fetch('/api/search?range=' + range + '&limit=2000&q=')
      if (!res.ok) throw new Error(String(res.status))
      return res.json()
    },
    refetchInterval: 60_000,
  })

  const rows = useMemo(() => {
    const groups = new Map<
      string,
      { application: string; method: string; route: string; n: number; errors: number; durations: number[]; last: number }
    >()
    for (const r of data?.rows ?? []) {
      // Group by the route template the SDK reported; fall back to collapsing
      // numeric and uuid-looking path segments so ids do not explode the list.
      const route =
        r.route ??
        (r.path ?? r.msg)
          .split('?')[0]
          .split('/')
          .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg) ? ':id' : seg))
          .join('/')
      const key = r.application + ' ' + (r.method ?? '-') + ' ' + route
      const g = groups.get(key) ?? {
        application: r.application,
        method: r.method ?? '-',
        route,
        n: 0,
        errors: 0,
        durations: [],
        last: 0,
      }
      g.n++
      if ((r.status ?? 0) >= 400) g.errors++
      if (r.duration != null) g.durations.push(r.duration)
      g.last = Math.max(g.last, r.ts)
      groups.set(key, g)
    }
    const pct = (arr: number[], p: number) => {
      if (!arr.length) return 0
      const s = [...arr].sort((a, b) => a - b)
      return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
    }
    return [...groups.values()]
      .map((g) => ({
        ...g,
        avg: g.durations.length ? g.durations.reduce((a, b) => a + b, 0) / g.durations.length : 0,
        p95: pct(g.durations, 95),
        p99: pct(g.durations, 99),
        max: g.durations.length ? Math.max(...g.durations) : 0,
      }))
      .sort((a, b) => b.n - a.n)
  }, [data])

  useEffect(() => {
    publish({ matching: rows.length, tookMs: data?.tookMs, connection: 'live' })
  }, [publish, rows.length, data?.tookMs])

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Box sx={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 2, px: 2, py: 1, borderBottom: '1px solid ' + C.border, background: C.panel }}>
        <Box sx={{ fontSize: 13, fontWeight: 600 }}>API Endpoints</Box>
        <Box sx={{ fontSize: 11, color: C.muted }}>
          Discovered from {(data?.rows.length ?? 0).toLocaleString()} sampled request lines
        </Box>
        <Box sx={{ flex: 1 }} />
        <TimeRangeSelector />
      </Box>
      <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
        <Panel title="Endpoints" hint={isFetching ? 'loading' : rows.length + ' routes'} flush minHeight={320}>
          <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse' }}>
            <Box component="thead" sx={{ position: 'sticky', top: 0, background: C.raised, zIndex: 1 }}>
              <Box component="tr">
                {['Application', 'Method', 'Route', 'Requests', 'Error rate', 'Avg', 'P95', 'P99', 'Max', 'Last seen'].map((h, i) => (
                  <Box
                    component="th"
                    key={h}
                    sx={{
                      textAlign: i > 2 ? 'right' : 'left',
                      fontSize: 10.5,
                      fontWeight: 500,
                      color: C.text2,
                      px: 1.5,
                      py: 0.75,
                      borderBottom: '1px solid ' + C.border,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {h}
                  </Box>
                ))}
              </Box>
            </Box>
            <Box component="tbody">
              {rows.length === 0 ? (
                <Box component="tr">
                  <Box component="td" colSpan={10} sx={{ px: 1.5, py: 2, fontSize: 11.5, color: C.muted }}>
                    No requests in this range.
                  </Box>
                </Box>
              ) : (
                rows.map((r) => (
                  <Box
                    component="tr"
                    key={r.application + r.method + r.route}
                    onClick={() => patchFilters({ query: 'route:' + r.route, application: r.application, service: r.application })}
                    sx={{ cursor: 'pointer', '&:hover': { background: C.raised } }}
                  >
                    <Cell>{r.application}</Cell>
                    <Cell color={C.info}>{r.method}</Cell>
                    <Cell color={C.text}>{r.route}</Cell>
                    <Cell right>{r.n.toLocaleString()}</Cell>
                    <Cell right color={r.errors / r.n > 0.02 ? C.error : C.text2}>
                      {((r.errors / r.n) * 100).toFixed(1)}%
                    </Cell>
                    <Cell right>{Math.round(r.avg)}ms</Cell>
                    <Cell right color={r.p95 > 1000 ? C.warning : C.text2}>
                      {Math.round(r.p95)}ms
                    </Cell>
                    <Cell right color={r.p99 > 1000 ? C.error : C.text2}>
                      {Math.round(r.p99)}ms
                    </Cell>
                    <Cell right>{Math.round(r.max)}ms</Cell>
                    <Cell right>{new Date(r.last).toLocaleTimeString(undefined, { hour12: false })}</Cell>
                  </Box>
                ))
              )}
            </Box>
          </Box>
        </Panel>
      </Box>
    </Box>
  )
}

/** Sticky header row for the table pages. `rightFrom` is the first column
 *  index that holds a number, since those align right. Shared by Endpoints,
 *  MCP Tools, Environments, Instances, Services and Traffic — they are
 *  deliberately the same table, so they are built from the same pieces. */
export function TableHead({ cols, rightFrom }: { cols: string[]; rightFrom: number }) {
  return (
    <Box component="thead" sx={{ position: 'sticky', top: 0, background: C.raised, zIndex: 1 }}>
      <Box component="tr">
        {cols.map((h, i) => (
          <Box
            component="th"
            key={h + i}
            sx={{
              textAlign: i >= rightFrom ? 'right' : 'left',
              fontSize: 10.5,
              fontWeight: 500,
              color: C.text2,
              px: 1.5,
              py: 0.75,
              borderBottom: '1px solid ' + C.border,
              whiteSpace: 'nowrap',
            }}
          >
            {h}
          </Box>
        ))}
      </Box>
    </Box>
  )
}

/** The "nothing here" row. Its own component so an empty table says why it is
 *  empty rather than just being blank, which reads as a broken page. */
export function EmptyRow({ cols, children }: { cols: number; children: React.ReactNode }) {
  return (
    <Box component="tr">
      <Box component="td" colSpan={cols} sx={{ px: 1.5, py: 2, fontSize: 11.5, color: C.muted, lineHeight: 1.7 }}>
        {children}
      </Box>
    </Box>
  )
}

export function Cell({
  children,
  right,
  color,
}: {
  children: React.ReactNode
  right?: boolean
  color?: string
}) {
  return (
    <Box
      component="td"
      sx={{
        px: 1.5,
        py: 0.5,
        fontFamily: MONO,
        fontSize: 11,
        color: color ?? C.text2,
        textAlign: right ? 'right' : 'left',
        borderBottom: '1px solid ' + C.border,
        whiteSpace: 'nowrap',
        maxWidth: 320,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {children}
    </Box>
  )
}
