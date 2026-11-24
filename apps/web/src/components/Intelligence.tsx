'use client'

import Box from '@mui/material/Box'
import dynamic from 'next/dynamic'
import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useConsole } from '../store/console'
import { C, MONO } from '../lib/tokens'
import type { SearchResponse } from '../lib/types'
import { Panel, RankedBars } from './Panel'
import { TimeRangeSelector } from './TimeRangeSelector'
import { MetricStrip, type Metric } from './MetricStrip'
import { useStatusFacts } from './status-context'

const Chart = dynamic(() => import('react-apexcharts'), { ssr: false, loading: () => <Box sx={{ height: '100%' }} /> })

function useSample(range: string, limit = 2000) {
  return useQuery<SearchResponse>({
    queryKey: ['sample', range, limit],
    queryFn: async () => {
      const res = await fetch('/api/search?range=' + range + '&limit=' + limit + '&q=')
      if (!res.ok) throw new Error(String(res.status))
      return res.json()
    },
    refetchInterval: 60_000,
  })
}

/** A fingerprint that groups the same fault together: numbers, ids, quoted
 *  strings and paths vary per occurrence and must not split the group. */
function fingerprint(message: string): string {
  return message
    .replace(/0x[0-9a-f]+/gi, '0xHEX')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{8,}/gi, 'UUID')
    .replace(/\b\d+(\.\d+)?(ms|s|kb|mb)?\b/gi, 'N')
    .replace(/"[^"]*"/g, '"S"')
    .replace(/'[^']*'/g, "'S'")
    .replace(/\/[\w\-./]+/g, '/PATH')
    .trim()
}

export function ErrorIntelligence() {
  const { range, patchFilters } = useConsole()
  const publish = useStatusFacts()
  const router = useRouter()
  const { data, isFetching } = useSample(range)

  const groups = useMemo(() => {
    const map = new Map<
      string,
      {
        fp: string
        sample: string
        type: string
        apps: Set<string>
        routes: Set<string>
        companies: Set<string>
        users: Set<string>
        count: number
        first: number
        last: number
        status?: number
      }
    >()
    for (const r of data?.rows ?? []) {
      if (r.level !== 'error' && r.level !== 'fatal' && (r.status ?? 0) < 500) continue
      const err = (r.payload?.err ?? r.payload?.error ?? r.payload?.exception) as Record<string, unknown> | undefined
      const message = String(err?.message ?? r.msg)
      const fp = fingerprint(message)
      const g = map.get(fp) ?? {
        fp,
        sample: message,
        type: String(err?.name ?? err?.type ?? (r.status ? 'HTTP ' + r.status : 'Error')),
        apps: new Set<string>(),
        routes: new Set<string>(),
        companies: new Set<string>(),
        users: new Set<string>(),
        count: 0,
        first: r.ts,
        last: r.ts,
        status: r.status,
      }
      g.count++
      g.apps.add(r.application)
      if (r.route ?? r.path) g.routes.add(String(r.route ?? r.path))
      if (r.company) g.companies.add(r.company)
      if (r.user) g.users.add(r.user)
      g.first = Math.min(g.first, r.ts)
      g.last = Math.max(g.last, r.ts)
      map.set(fp, g)
    }
    return [...map.values()].sort((a, b) => b.count - a.count)
  }, [data])

  useEffect(() => {
    publish({ matching: groups.length, tookMs: data?.tookMs, connection: 'live' })
  }, [publish, groups.length, data?.tookMs])

  const totalErrors = groups.reduce((a, g) => a + g.count, 0)
  const affectedCompanies = new Set(groups.flatMap((g) => [...g.companies])).size

  const metrics: Metric[] = [
    { label: 'Error groups', value: String(groups.length), tone: groups.length ? C.error : C.success },
    { label: 'Occurrences', value: totalErrors.toLocaleString(), tone: C.error },
    { label: 'Affected clients', value: String(affectedCompanies), tone: affectedCompanies ? C.warning : C.success },
    { label: 'Applications hit', value: String(new Set(groups.flatMap((g) => [...g.apps])).size) },
  ]

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Head title="Error Intelligence" hint="Grouped by normalised fault signature, newest sample shown" />
      <MetricStrip metrics={metrics} />
      <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
        <Panel title="Error groups" hint={isFetching ? 'loading' : groups.length + ' distinct faults'} flush minHeight={320}>
          {groups.length === 0 ? (
            <Box sx={{ p: 2, fontSize: 11.5, color: C.muted }}>
              No errors in this range. That is the good case.
            </Box>
          ) : (
            groups.map((g) => (
              <Box
                key={g.fp}
                onClick={() => {
                  patchFilters({ levels: ['error'], query: '' })
                  router.push('/explorer')
                }}
                sx={{
                  display: 'grid',
                  gridTemplateColumns: '150px minmax(0, 1fr) 76px 92px 110px',
                  gap: 1.5,
                  alignItems: 'center',
                  px: 2,
                  py: 1,
                  borderBottom: '1px solid ' + C.border,
                  cursor: 'pointer',
                  '&:hover': { background: C.raised },
                }}
              >
                <Box sx={{ fontFamily: MONO, fontSize: 11, color: C.error, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {g.type}
                </Box>
                <Box sx={{ minWidth: 0 }}>
                  <Box
                    sx={{
                      fontFamily: MONO,
                      fontSize: 11.5,
                      color: C.text,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={g.sample}
                  >
                    {g.sample}
                  </Box>
                  <Box sx={{ fontSize: 10.5, color: C.muted, mt: 0.25 }}>
                    {[...g.apps].join(', ')}
                    {g.routes.size ? ' · ' + [...g.routes].slice(0, 2).join(', ') : ''}
                  </Box>
                </Box>
                <Box sx={{ fontFamily: MONO, fontSize: 12, color: C.text, textAlign: 'right' }}>{g.count}</Box>
                <Box sx={{ fontFamily: MONO, fontSize: 10.5, color: C.text2, textAlign: 'right' }}>
                  {g.companies.size} client{g.companies.size === 1 ? '' : 's'}
                </Box>
                <Box sx={{ fontFamily: MONO, fontSize: 10.5, color: C.muted, textAlign: 'right' }}>
                  {new Date(g.last).toLocaleTimeString(undefined, { hour12: false })}
                </Box>
              </Box>
            ))
          )}
        </Panel>

        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 2, mt: 2 }}>
          <Panel title="Faults by application">
            <RankedBars
              rows={Object.entries(
                groups.reduce<Record<string, number>>((acc, g) => {
                  for (const a of g.apps) acc[a] = (acc[a] ?? 0) + g.count
                  return acc
                }, {}),
              ).map(([name, value]) => ({ name, value }))}
              tone={C.error}
            />
          </Panel>
          <Panel title="Clients affected">
            <RankedBars
              rows={Object.entries(
                groups.reduce<Record<string, number>>((acc, g) => {
                  for (const c of g.companies) acc[c] = (acc[c] ?? 0) + g.count
                  return acc
                }, {}),
              ).map(([name, value]) => ({ name, value }))}
              tone={C.purple}
            />
          </Panel>
          <Panel title="Workflow" hint="not built yet">
            <Box sx={{ fontSize: 11.5, color: C.muted, lineHeight: 1.7 }}>
              Assignment, acknowledgement, notes and regression detection need a place to store state per fault.
              That is a schema change, so it comes with the Postgres migration rather than before it.
            </Box>
          </Panel>
        </Box>
      </Box>
    </Box>
  )
}

export function Performance() {
  const { range } = useConsole()
  const publish = useStatusFacts()
  const { data, isFetching } = useSample(range)

  const stats = useMemo(() => {
    const durations = (data?.rows ?? []).map((r) => r.duration).filter((d): d is number => typeof d === 'number')
    const sorted = [...durations].sort((a, b) => a - b)
    const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0)

    // Log-ish buckets: latency is heavy-tailed, so equal-width bins hide the tail.
    const edges = [0, 10, 25, 50, 100, 200, 400, 800, 1600, 3200, 6400]
    const hist = edges.map((e, i) => ({
      label: i === edges.length - 1 ? e + 'ms+' : e + '–' + edges[i + 1] + 'ms',
      count: durations.filter((d) => d >= e && (i === edges.length - 1 || d < edges[i + 1])).length,
    }))

    const byApp = new Map<string, number[]>()
    for (const r of data?.rows ?? []) {
      if (r.duration == null) continue
      const list = byApp.get(r.application) ?? []
      list.push(r.duration)
      byApp.set(r.application, list)
    }

    return {
      n: durations.length,
      avg: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
      p50: pct(50),
      p95: pct(95),
      p99: pct(99),
      max: sorted.length ? sorted[sorted.length - 1] : 0,
      hist,
      byApp: [...byApp.entries()]
        .map(([name, list]) => ({
          name,
          value: Math.round(list.reduce((a, b) => a + b, 0) / list.length),
          p95: Math.round(list.sort((a, b) => a - b)[Math.floor(list.length * 0.95)] ?? 0),
        }))
        .sort((a, b) => b.value - a.value),
    }
  }, [data])

  useEffect(() => {
    publish({ matching: stats.n, tookMs: data?.tookMs, connection: 'live' })
  }, [publish, stats.n, data?.tookMs])

  const metrics: Metric[] = [
    { label: 'Sampled requests', value: stats.n.toLocaleString() },
    { label: 'Mean', value: Math.round(stats.avg) + 'ms', hint: 'The mean hides the tail; read it beside P95.' },
    { label: 'P50', value: Math.round(stats.p50) + 'ms' },
    { label: 'P95', value: Math.round(stats.p95) + 'ms', tone: stats.p95 > 1000 ? C.warning : C.text },
    { label: 'P99', value: Math.round(stats.p99) + 'ms', tone: stats.p99 > 1000 ? C.error : C.text },
    { label: 'Slowest', value: Math.round(stats.max) + 'ms', tone: C.error },
  ]

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Head title="Performance" hint="Percentiles from sampled request lines, not from the counters" />
      <MetricStrip metrics={metrics} />
      <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 2 }}>
          <Panel title="Latency distribution" hint={isFetching ? 'loading' : stats.n + ' requests'} span={2} minHeight={230}>
            <Chart
              type="bar"
              height={180}
              series={[{ name: 'Requests', data: stats.hist.map((h) => h.count) }]}
              options={{
                chart: { type: 'bar', background: 'transparent', toolbar: { show: false }, animations: { enabled: false }, fontFamily: MONO },
                theme: { mode: 'dark' },
                colors: [C.info],
                plotOptions: { bar: { columnWidth: '68%', borderRadius: 1 } },
                dataLabels: { enabled: false },
                grid: { borderColor: '#1A232C', xaxis: { lines: { show: false } } },
                xaxis: {
                  categories: stats.hist.map((h) => h.label),
                  labels: { style: { colors: C.muted, fontSize: '9px' }, rotate: -35, hideOverlappingLabels: false },
                  axisBorder: { color: C.border },
                  axisTicks: { show: false },
                },
                yaxis: { labels: { style: { colors: C.muted, fontSize: '9px' } }, tickAmount: 3 },
                tooltip: { theme: 'dark' },
              }}
            />
          </Panel>
          <Panel title="Mean latency by application">
            <RankedBars rows={stats.byApp.map((a) => ({ name: a.name, value: a.value }))} tone={C.warning} unit="ms" />
          </Panel>
          <Panel title="P95 by application">
            <RankedBars rows={stats.byApp.map((a) => ({ name: a.name, value: a.p95 }))} tone={C.error} unit="ms" />
          </Panel>
          <Panel title="Heatmaps and deployment correlation" hint="not built yet">
            <Box sx={{ fontSize: 11.5, color: C.muted, lineHeight: 1.7 }}>
              Latency heatmaps over time, and correlating a latency change against a deployment, both need data the
              gateway does not collect yet: per-bucket latency histograms and a deployment feed.
            </Box>
          </Panel>
        </Box>
      </Box>
    </Box>
  )
}

function Head({ title, hint }: { title: string; hint: string }) {
  return (
    <Box
      sx={{
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        px: 2,
        py: 1,
        borderBottom: '1px solid ' + C.border,
        background: C.panel,
      }}
    >
      <Box sx={{ fontSize: 13, fontWeight: 600 }}>{title}</Box>
      <Box sx={{ fontSize: 11, color: C.muted }}>{hint}</Box>
      <Box sx={{ flex: 1 }} />
      <TimeRangeSelector />
    </Box>
  )
}
