'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { RefreshCw } from 'lucide-react'
import { useConsole } from '../store/console'
import { C, MONO } from '../lib/tokens'
import type { OverviewResponse, SearchResponse } from '../lib/types'
import { MetricStrip, bucketsToSpark, type Metric } from './MetricStrip'
import { Panel, RankedBars } from './Panel'
import { TrafficHistogram } from './TrafficHistogram'
import { TimeRangeSelector } from './TimeRangeSelector'
import { useStatusFacts } from './status-context'
import { LatencyIndicator, StatusCodeIndicator } from './indicators'

function compact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return n.toLocaleString()
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[i]
}

export function Overview() {
  const { range, patchFilters } = useConsole()
  const publish = useStatusFacts()
  const router = useRouter()

  const { data, isFetching, refetch, isError } = useQuery<OverviewResponse>({
    queryKey: ['overview', range],
    queryFn: async () => {
      const res = await fetch('/api/overview?range=' + range)
      if (!res.ok) throw new Error(String(res.status))
      return res.json()
    },
    refetchInterval: 15_000,
  })

  // Latency comes from the request lines themselves; the counters do not store it.
  const { data: sample } = useQuery<SearchResponse>({
    queryKey: ['overview-sample', range],
    queryFn: async () => {
      const res = await fetch('/api/search?range=' + range + '&limit=1000&q=')
      if (!res.ok) throw new Error(String(res.status))
      return res.json()
    },
    refetchInterval: 30_000,
  })

  const latency = useMemo(() => {
    const values = (sample?.rows ?? []).map((r) => r.duration).filter((d): d is number => typeof d === 'number')
    return {
      count: values.length,
      avg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0,
      p50: percentile(values, 50),
      p95: percentile(values, 95),
      p99: percentile(values, 99),
    }
  }, [sample])

  const statusMix = useMemo(() => {
    const mix = new Map<string, number>()
    for (const r of sample?.rows ?? []) {
      if (r.status == null) continue
      const k = Math.floor(r.status / 100) + 'xx'
      mix.set(k, (mix.get(k) ?? 0) + 1)
    }
    return ['2xx', '3xx', '4xx', '5xx'].map((k) => ({ name: k, value: mix.get(k) ?? 0 }))
  }, [sample])

  const slowest = useMemo(() => {
    const byRoute = new Map<string, { total: number; n: number; errors: number }>()
    for (const r of sample?.rows ?? []) {
      const key = (r.method ? r.method + ' ' : '') + (r.route ?? r.path ?? r.msg)
      if (r.duration == null) continue
      const acc = byRoute.get(key) ?? { total: 0, n: 0, errors: 0 }
      acc.total += r.duration
      acc.n++
      if ((r.status ?? 0) >= 500) acc.errors++
      byRoute.set(key, acc)
    }
    return [...byRoute.entries()]
      .map(([name, v]) => ({ name, value: Math.round(v.total / v.n), secondary: v.errors }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)
  }, [sample])

  const failing = useMemo(() => {
    const byRoute = new Map<string, number>()
    for (const r of sample?.rows ?? []) {
      if ((r.status ?? 0) < 400) continue
      const key = (r.method ? r.method + ' ' : '') + (r.route ?? r.path ?? r.msg)
      byRoute.set(key, (byRoute.get(key) ?? 0) + 1)
    }
    return [...byRoute.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)
  }, [sample])

  const recentErrors = useMemo(
    () => (sample?.rows ?? []).filter((r) => r.level === 'error' || r.level === 'fatal').slice(0, 14),
    [sample],
  )

  useEffect(() => {
    publish({ matching: data?.requests, tookMs: sample?.tookMs, connection: 'live' })
  }, [publish, data?.requests, sample?.tookMs])

  const metrics: Metric[] = [
    { label: 'Total requests', value: compact(data?.requests ?? 0), spark: bucketsToSpark(data?.buckets ?? []), tone: C.info },
    { label: 'Requests / sec', value: (data?.perSecond ?? 0).toFixed(2), tone: C.text },
    // These three are null until the range contains hours recorded with the
    // status columns. `?? 1` would have read as a flat 100% success — the exact
    // reassuring lie worth avoiding, so an unknown rate renders as a dash.
    {
      label: 'Success rate',
      value: data?.successRate == null ? '—' : (data.successRate * 100).toFixed(1) + '%',
      tone:
        data?.successRate == null
          ? C.muted
          : data.successRate > 0.98
            ? C.success
            : data.successRate > 0.95
              ? C.warning
              : C.error,
    },
    {
      label: 'Client error rate',
      value: data?.clientErrorRate == null ? '—' : (data.clientErrorRate * 100).toFixed(2) + '%',
      tone: data?.clientErrorRate == null ? C.muted : data.clientErrorRate > 0.1 ? C.warning : C.text,
    },
    {
      label: 'Server error rate',
      value: data?.serverErrorRate == null ? '—' : (data.serverErrorRate * 100).toFixed(2) + '%',
      tone: data?.serverErrorRate == null ? C.muted : data.serverErrorRate > 0.02 ? C.error : C.text,
      spark: bucketsToSpark(data?.buckets ?? [], 'errors'),
      deltaGoodWhenUp: false,
    },
    {
      label: 'Avg latency',
      value: latency.count ? Math.round(latency.avg) + 'ms' : '—',
      hint: latency.count ? 'From ' + latency.count.toLocaleString() + ' sampled request lines' : undefined,
    },
    { label: 'P95 latency', value: latency.count ? Math.round(latency.p95) + 'ms' : '—', tone: C.warning },
    { label: 'P99 latency', value: latency.count ? Math.round(latency.p99) + 'ms' : '—', tone: C.error },
    { label: 'Applications', value: String(data?.applications ?? 0) },
  ]

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
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
        <Box sx={{ fontSize: 13, fontWeight: 600 }}>Overview</Box>
        <Box sx={{ fontSize: 11, color: C.muted }}>
          {isError ? 'Could not load counters' : 'Counted at ingest, so this is instant over any range'}
        </Box>
        <Box sx={{ flex: 1 }} />
        <TimeRangeSelector />
        <Button onClick={() => void refetch()} startIcon={<RefreshCw size={12} />} disabled={isFetching}>
          {isFetching ? 'Refreshing' : 'Refresh'}
        </Button>
      </Box>

      <MetricStrip metrics={metrics} />

      <Box sx={{ flex: 1, overflow: 'auto', p: 2, minHeight: 0 }}>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(330px, 1fr))',
            gap: 2,
            alignItems: 'start',
          }}
        >
          <Panel title="Request volume" hint={'per ' + (range === '7d' || range === '30d' ? 'day' : 'hour')} span={2} minHeight={210}>
            <TrafficHistogram buckets={data?.buckets ?? []} height={160} />
          </Panel>

          <Panel title="Status codes" hint={sample?.rows.length ? 'from ' + sample.rows.length + ' sampled lines' : undefined}>
            <RankedBars
              rows={statusMix}
              tone={C.info}
              onPick={(name) => {
                patchFilters({ statusClasses: [name] })
                router.push('/explorer')
              }}
            />
          </Panel>

          <Panel title="Requests by application">
            <RankedBars
              rows={(data?.byApplication ?? []).map((a) => ({ name: a.name, value: a.requests, secondary: a.errors }))}
              onPick={(name) => {
                patchFilters({ application: name, service: name })
                router.push('/explorer')
              }}
            />
          </Panel>

          <Panel title="Top clients" hint="by request count">
            <RankedBars
              rows={(data?.topClients ?? []).map((c) => ({ name: c.name, value: c.requests, secondary: c.errors }))}
              tone={C.purple}
              onPick={(name) => {
                patchFilters({ query: 'company:' + name })
                router.push('/explorer')
              }}
            />
          </Panel>

          <Panel title="Slowest endpoints" hint="mean latency">
            <RankedBars rows={slowest} tone={C.warning} unit="ms" />
          </Panel>

          <Panel title="Most failing endpoints" hint="4xx and 5xx">
            <RankedBars rows={failing} tone={C.error} />
          </Panel>

          <Panel title="Recent errors" span={2} minHeight={240} flush>
            {recentErrors.length === 0 ? (
              <Box sx={{ p: 2, fontSize: 11.5, color: C.muted }}>No errors in this range. </Box>
            ) : (
              <Box>
                {recentErrors.map((r) => (
                  <Box
                    key={r.id}
                    onClick={() => {
                      patchFilters({ query: r.requestId ? 'request:' + r.requestId : '', levels: ['error'] })
                      router.push('/explorer')
                    }}
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: '78px 70px 1fr 60px 64px',
                      gap: 1.5,
                      alignItems: 'center',
                      px: 2,
                      height: 26,
                      borderBottom: '1px solid ' + C.border,
                      cursor: 'pointer',
                      '&:hover': { background: C.raised },
                    }}
                  >
                    <Box sx={{ fontFamily: MONO, fontSize: 10.5, color: C.muted }}>
                      {new Date(r.ts).toLocaleTimeString(undefined, { hour12: false })}
                    </Box>
                    <Box sx={{ fontFamily: MONO, fontSize: 10.5, color: C.text2 }}>{r.application}</Box>
                    <Box
                      sx={{
                        fontFamily: MONO,
                        fontSize: 11,
                        color: C.text,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={r.msg}
                    >
                      {r.msg}
                    </Box>
                    <StatusCodeIndicator status={r.status} />
                    <Box sx={{ textAlign: 'right' }}>
                      <LatencyIndicator ms={r.duration} />
                    </Box>
                  </Box>
                ))}
              </Box>
            )}
          </Panel>

          <Panel title="Application health" hint="error rate against volume">
            <RankedBars
              rows={(data?.byApplication ?? []).map((a) => ({
                name: a.name,
                value: a.requests ? Math.round((a.errors / a.requests) * 1000) / 10 : 0,
              }))}
              tone={C.error}
              unit="%"
            />
          </Panel>

          <Panel title="Active incidents" hint="not built yet">
            <Box sx={{ fontSize: 11.5, color: C.muted, lineHeight: 1.7 }}>
              Alert rules and incidents are the next thing to build. When they exist, anything firing shows here with
              its timeline and the query that found it.
            </Box>
          </Panel>
        </Box>
      </Box>
    </Box>
  )
}
