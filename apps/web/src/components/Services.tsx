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

interface ServiceRow {
  service: string
  env: string
  lines: number
  errors: number
  instances: number
}

/** Every service, per environment, with how many instances it is running on.
 *
 *  `service` and `env` are indexed Loki labels, so these counts are exact and
 *  cheap. The instance count needs the line body parsed, which is why it can be
 *  zero for a service whose client runs with `instance: false`. */
export function Services() {
  const { range, patchFilters } = useConsole()
  const publish = useStatusFacts()
  const { data, isFetching } = useQuery<{ rows: ServiceRow[]; tookMs: number }>({
    queryKey: ['services', range],
    queryFn: async () => {
      const res = await fetch('/api/services?range=' + range)
      if (!res.ok) throw new Error(String(res.status))
      return res.json()
    },
    refetchInterval: 60_000,
  })

  const rows = data?.rows ?? []
  const totals = useMemo(
    () => ({
      lines: rows.reduce((n, r) => n + r.lines, 0),
      services: new Set(rows.map((r) => r.service)).size,
    }),
    [rows],
  )

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
        <Box sx={{ fontSize: 13, fontWeight: 600 }}>Services</Box>
        <Box sx={{ fontSize: 11, color: C.muted }}>
          {totals.services} across {rows.length} service/environment pairs, {totals.lines.toLocaleString()} lines —
          counted across the whole range, not sampled
        </Box>
        <Box sx={{ flex: 1 }} />
        <TimeRangeSelector />
      </Box>

      <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
        <Panel title="Services" hint={isFetching ? 'loading' : rows.length + ' rows'} flush minHeight={320}>
          <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse' }}>
            <TableHead
              cols={['Service', 'Environment', 'Instances', 'Lines', 'Errors', 'Error rate']}
              rightFrom={2}
            />
            <Box component="tbody">
              {rows.length === 0 ? (
                <EmptyRow cols={6}>No service sent anything in this range.</EmptyRow>
              ) : (
                rows.map((r) => (
                  <Box
                    component="tr"
                    key={r.service + r.env}
                    onClick={() =>
                      patchFilters({ query: 'env:' + r.env, service: r.service, application: r.service })
                    }
                    sx={{ cursor: 'pointer', '&:hover': { background: C.raised } }}
                  >
                    <Cell color={C.text}>{r.service}</Cell>
                    <Cell>{r.env}</Cell>
                    {/* A zero here is a reporting gap, not an absence of hosts:
                        the service is sending lines, so something is running. */}
                    <Cell right color={r.instances === 0 ? C.muted : C.text2}>
                      {r.instances === 0 ? 'not reported' : r.instances}
                    </Cell>
                    <Cell right>{r.lines.toLocaleString()}</Cell>
                    <Cell right color={r.errors > 0 ? C.error : C.text2}>
                      {r.errors.toLocaleString()}
                    </Cell>
                    <Cell right color={r.lines && r.errors / r.lines > 0.02 ? C.error : C.text2}>
                      {r.lines ? ((r.errors / r.lines) * 100).toFixed(1) + '%' : '—'}
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
