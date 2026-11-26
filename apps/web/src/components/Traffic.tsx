'use client'

import Box from '@mui/material/Box'
import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useConsole } from '../store/console'
import { C } from '../lib/tokens'
import type { Bucket } from '../lib/types'
import { TimeRangeSelector } from './TimeRangeSelector'
import { TrafficHistogram } from './TrafficHistogram'
import { Panel } from './Panel'
import { Cell, EmptyRow, TableHead } from './LogExplorer'
import { useStatusFacts } from './status-context'

interface OverviewData {
  requests: number
  perSecond: number
  successRate: number | null
  clientErrorRate: number | null
  serverErrorRate: number | null
  classified: number
  lines: number
  errors: number
  bytes: number
  buckets: Bucket[]
  byApplication: { name: string; requests: number; errors: number }[]
}

const pct = (v: number | null) => (v == null ? '—' : (v * 100).toFixed(2) + '%')

/** Traffic by HTTP status class, from the usage counters rather than a sample.
 *
 *  This page was a placeholder waiting on "per-bucket breakdowns, which the
 *  counters lack". The counters now record status classes, so it can be built —
 *  with one honest limit kept visible: the classes are recorded from the
 *  release that added them onwards, so a range reaching further back has
 *  requests it cannot classify. */
export function Traffic() {
  const { range, patchFilters } = useConsole()
  const publish = useStatusFacts()
  const { data, isFetching } = useQuery<OverviewData>({
    queryKey: ['traffic', range],
    queryFn: async () => {
      const res = await fetch('/api/overview?range=' + range)
      if (!res.ok) throw new Error(String(res.status))
      return res.json()
    },
    refetchInterval: 30_000,
  })

  const classes = useMemo(() => {
    if (!data || !data.classified) return null
    const client = Math.round((data.clientErrorRate ?? 0) * data.classified)
    const server = Math.round((data.serverErrorRate ?? 0) * data.classified)
    return { ok: data.classified - client - server, client, server, total: data.classified }
  }, [data])

  /** Requests counted but recorded before status classes existed. */
  const unclassified = Math.max(0, (data?.requests ?? 0) - (data?.classified ?? 0))

  useEffect(() => {
    publish({ matching: data?.requests, tookMs: undefined, connection: 'live' })
  }, [publish, data?.requests])

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
        <Box sx={{ fontSize: 13, fontWeight: 600 }}>Traffic Analytics</Box>
        <Box sx={{ fontSize: 11, color: C.muted }}>
          {(data?.requests ?? 0).toLocaleString()} requests, {(data?.lines ?? 0).toLocaleString()} lines — counted at
          ingest
        </Box>
        <Box sx={{ flex: 1 }} />
        <TimeRangeSelector />
      </Box>

      <Box sx={{ flex: 1, overflow: 'auto', p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Panel title="Volume" hint={isFetching ? 'loading' : 'requests and errors'} minHeight={180}>
          <TrafficHistogram buckets={data?.buckets ?? []} />
        </Panel>

        <Panel
          title="By status class"
          hint={classes ? classes.total.toLocaleString() + ' classified requests' : 'no classified requests'}
          flush
          minHeight={0}
        >
          {classes === null ? (
            <Box sx={{ p: 2, fontSize: 11.5, color: C.muted, lineHeight: 1.7 }}>
              No request in this range carried a status that was recorded as a class. Status classes are counted from
              the release that added them onwards, so a range reaching back before it has nothing to show here. A
              shorter range will.
            </Box>
          ) : (
            <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse' }}>
              <TableHead cols={['Class', 'Requests', 'Share']} rightFrom={1} />
              <Box component="tbody">
                {[
                  { label: '2xx / 3xx — succeeded', n: classes.ok, tone: C.success, q: '' },
                  { label: '4xx — client error', n: classes.client, tone: C.warning, q: 'status:>=400 status:<500' },
                  { label: '5xx — server error', n: classes.server, tone: C.error, q: 'status:>=500' },
                ].map((row) => (
                  <Box
                    component="tr"
                    key={row.label}
                    onClick={row.q ? () => patchFilters({ query: row.q }) : undefined}
                    sx={{ cursor: row.q ? 'pointer' : 'default', '&:hover': { background: C.raised } }}
                  >
                    <Cell color={row.tone}>{row.label}</Cell>
                    <Cell right>{row.n.toLocaleString()}</Cell>
                    <Cell right>{classes.total ? ((row.n / classes.total) * 100).toFixed(2) + '%' : '—'}</Cell>
                  </Box>
                ))}
              </Box>
            </Box>
          )}
          {unclassified > 0 ? (
            <Box sx={{ px: 2, py: 1.5, fontSize: 11, color: C.muted, lineHeight: 1.7 }}>
              {unclassified.toLocaleString()} further requests in this range carry no status class, because they were
              counted before the classes were recorded. They are in the request total above and in no row here —
              counting them as successes is exactly the assumption worth avoiding.
            </Box>
          ) : null}
        </Panel>

        <Panel title="Rates" hint="from HTTP status, not log level" minHeight={0}>
          <Box sx={{ display: 'flex', gap: 4, flexWrap: 'wrap', fontSize: 11.5 }}>
            {[
              { label: 'Success', v: data?.successRate ?? null, tone: C.success },
              { label: 'Client error', v: data?.clientErrorRate ?? null, tone: C.warning },
              { label: 'Server error', v: data?.serverErrorRate ?? null, tone: C.error },
              { label: 'Requests / sec', v: null, text: (data?.perSecond ?? 0).toFixed(2), tone: C.text },
            ].map((m) => (
              <Box key={m.label}>
                <Box sx={{ fontSize: 10.5, color: C.muted }}>{m.label}</Box>
                <Box sx={{ fontSize: 15, color: m.v == null && !m.text ? C.muted : m.tone }}>
                  {m.text ?? pct(m.v)}
                </Box>
              </Box>
            ))}
          </Box>
        </Panel>

        <Panel title="By application" hint={(data?.byApplication.length ?? 0) + ' applications'} flush minHeight={0}>
          <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse' }}>
            <TableHead cols={['Application', 'Requests', 'Error lines', 'Share']} rightFrom={1} />
            <Box component="tbody">
              {(data?.byApplication.length ?? 0) === 0 ? (
                <EmptyRow cols={4}>No application sent a request in this range.</EmptyRow>
              ) : (
                (data?.byApplication ?? []).map((a) => (
                  <Box
                    component="tr"
                    key={a.name}
                    onClick={() => patchFilters({ application: a.name, service: a.name })}
                    sx={{ cursor: 'pointer', '&:hover': { background: C.raised } }}
                  >
                    <Cell color={C.text}>{a.name}</Cell>
                    <Cell right>{a.requests.toLocaleString()}</Cell>
                    {/* Error-LEVEL lines, which is a different measurement from
                        the 5xx count above and must not be read as the same. */}
                    <Cell right color={a.errors > 0 ? C.error : C.text2}>
                      {a.errors.toLocaleString()}
                    </Cell>
                    <Cell right>
                      {data?.requests ? ((a.requests / data.requests) * 100).toFixed(1) + '%' : '—'}
                    </Cell>
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
