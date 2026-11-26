'use client'

import Box from '@mui/material/Box'
import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useConsole } from '../store/console'
import { C } from '../lib/tokens'
import { TimeRangeSelector } from './TimeRangeSelector'
import { Panel } from './Panel'
import { Cell, EmptyRow, TableHead } from './LogExplorer'
import { useStatusFacts } from './status-context'

interface EnvRow {
  env: string
  lines: number
  errors: number
  services: { service: string; lines: number }[]
}

interface EnvOverview {
  rows: EnvRow[]
  silent: string[]
  tookMs: number
}

/** Compares the same application across the environments it runs in.
 *
 *  Unlike every other aggregate panel in this console, these numbers are not
 *  sampled: `env` is an indexed Loki label, so the counts come from
 *  count_over_time across the whole range and are exact. The page says so,
 *  because the sampled panels elsewhere look identical and are not. */
export function Environments() {
  const { range, patchFilters } = useConsole()
  const publish = useStatusFacts()
  const { data, isFetching } = useQuery<EnvOverview>({
    queryKey: ['environments', range],
    queryFn: async () => {
      const res = await fetch('/api/environments?range=' + range)
      if (!res.ok) throw new Error(String(res.status))
      return res.json()
    },
    refetchInterval: 60_000,
  })

  const rows = data?.rows ?? []
  const silent = data?.silent ?? []

  // Every service seen in any environment, so the matrix below has a stable
  // column set and a gap is visibly a gap rather than a missing column.
  const services = useMemo(() => {
    const all = new Set<string>()
    for (const r of rows) for (const s of r.services) all.add(s.service)
    return [...all].sort()
  }, [rows])

  const totalLines = useMemo(() => rows.reduce((n, r) => n + r.lines, 0), [rows])

  useEffect(() => {
    publish({ matching: rows.length, tookMs: data?.tookMs, connection: 'live' })
  }, [publish, rows.length, data?.tookMs])

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
        <Box sx={{ fontSize: 13, fontWeight: 600 }}>Environments</Box>
        <Box sx={{ fontSize: 11, color: C.muted }}>
          {rows.length} reporting, {totalLines.toLocaleString()} lines — counted across the whole range, not sampled
        </Box>
        <Box sx={{ flex: 1 }} />
        <TimeRangeSelector />
      </Box>

      <Box sx={{ flex: 1, overflow: 'auto', p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Panel title="Environments" hint={isFetching ? 'loading' : rows.length + ' reporting'} flush minHeight={200}>
          <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse' }}>
            <TableHead cols={['Environment', 'Services', 'Lines', 'Errors', 'Error rate', 'Share']} rightFrom={2} />
            <Box component="tbody">
              {rows.length === 0 ? (
                <EmptyRow cols={6}>No lines in this range.</EmptyRow>
              ) : (
                rows.map((r) => (
                  <Box
                    component="tr"
                    key={r.env}
                    onClick={() => patchFilters({ query: 'env:' + r.env })}
                    sx={{ cursor: 'pointer', '&:hover': { background: C.raised } }}
                  >
                    <Cell color={C.text}>{r.env}</Cell>
                    <Cell>{r.services.length}</Cell>
                    <Cell right>{r.lines.toLocaleString()}</Cell>
                    <Cell right color={r.errors > 0 ? C.error : C.text2}>
                      {r.errors.toLocaleString()}
                    </Cell>
                    <Cell right color={r.lines && r.errors / r.lines > 0.02 ? C.error : C.text2}>
                      {r.lines ? ((r.errors / r.lines) * 100).toFixed(1) + '%' : '—'}
                    </Cell>
                    <Cell right>{totalLines ? ((r.lines / totalLines) * 100).toFixed(0) + '%' : '—'}</Cell>
                  </Box>
                ))
              )}
            </Box>
          </Box>
        </Panel>

        {/* The comparison the page exists for: one service read across its
            environments, where a blank cell means it is not running there. */}
        <Panel title="Service by environment" hint={services.length + ' services'} flush minHeight={160}>
          <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse' }}>
            <TableHead cols={['Service', ...rows.map((r) => r.env)]} rightFrom={1} />
            <Box component="tbody">
              {services.length === 0 ? (
                <EmptyRow cols={rows.length + 1}>Nothing reporting yet.</EmptyRow>
              ) : (
                services.map((service) => (
                  <Box component="tr" key={service} sx={{ '&:hover': { background: C.raised } }}>
                    <Cell color={C.text}>{service}</Cell>
                    {rows.map((r) => {
                      const hit = r.services.find((s) => s.service === service)
                      return (
                        <Cell key={r.env} right color={hit ? C.text2 : C.muted}>
                          {hit ? hit.lines.toLocaleString() : '—'}
                        </Cell>
                      )
                    })}
                  </Box>
                ))
              )}
            </Box>
          </Box>
        </Panel>

        {silent.length > 0 ? (
          <Panel title="Silent environments" hint={silent.length + ' with no lines'} minHeight={0}>
            <Box sx={{ fontSize: 11.5, color: C.text2, lineHeight: 1.8 }}>
              {silent.join(', ')}
            </Box>
            <Box sx={{ fontSize: 11, color: C.muted, mt: 1, lineHeight: 1.7 }}>
              Loki holds lines for these environments but none arrived in this range. Either nothing is running there, or
              something stopped sending — this page cannot tell the two apart.
            </Box>
          </Panel>
        ) : null}
      </Box>
    </Box>
  )
}
