'use client'

import Box from '@mui/material/Box'
import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useConsole } from '../store/console'
import { C } from '../lib/tokens'
import { TimeRangeSelector } from './TimeRangeSelector'
import { Panel } from './Panel'
import { Cell, TableHead, EmptyRow } from './LogExplorer'
import { useStatusFacts } from './status-context'

interface InstanceRow {
  instance: string
  service: string
  env: string
  lines: number
  errors: number
  quietForMs: number | null
  resolutionMs: number
}

/** A replica is considered quiet once it has missed more than two buckets. One
 *  missed bucket is ordinary jitter at the edge of the range; two is a gap. */
const QUIET_BUCKETS = 2

function age(ms: number): string {
  if (ms < 60_000) return Math.round(ms / 1000) + 's'
  if (ms < 3_600_000) return Math.round(ms / 60_000) + 'm'
  if (ms < 86_400_000) return (ms / 3_600_000).toFixed(1) + 'h'
  return (ms / 86_400_000).toFixed(1) + 'd'
}

/** Which hosts or containers are reporting, and which have gone quiet.
 *
 *  The counts are exact rather than sampled, which is the whole point: an
 *  instance that stopped an hour ago does not appear in a sample of the newest
 *  lines, and "which replica went quiet?" is the question this page exists to
 *  answer. */
export function Instances() {
  const { range, patchFilters } = useConsole()
  const publish = useStatusFacts()
  const { data, isFetching } = useQuery<{ rows: InstanceRow[]; tookMs: number }>({
    queryKey: ['instances', range],
    queryFn: async () => {
      const res = await fetch('/api/instances?range=' + range)
      if (!res.ok) throw new Error(String(res.status))
      return res.json()
    },
    refetchInterval: 30_000,
  })

  const rows = data?.rows ?? []
  const quiet = useMemo(
    () => rows.filter((r) => r.quietForMs != null && r.quietForMs > r.resolutionMs * QUIET_BUCKETS),
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
        <Box sx={{ fontSize: 13, fontWeight: 600 }}>Instances</Box>
        <Box sx={{ fontSize: 11, color: C.muted }}>
          {rows.length} reporting
          {quiet.length > 0 ? ', ' + quiet.length + ' gone quiet' : ''} — counted across the whole range, not sampled
        </Box>
        <Box sx={{ flex: 1 }} />
        <TimeRangeSelector />
      </Box>

      <Box sx={{ flex: 1, overflow: 'auto', p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {quiet.length > 0 ? (
          <Panel title="Gone quiet" hint={quiet.length + ' instances'} minHeight={0}>
            <Box sx={{ fontSize: 11.5, color: C.text2, lineHeight: 1.9 }}>
              {quiet.map((r) => (
                <Box key={r.instance + r.env}>
                  <Box component="span" sx={{ color: C.warning }}>
                    {r.instance}
                  </Box>
                  {' — ' + r.service + '/' + r.env + ', last reported about ' + age(r.quietForMs ?? 0) + ' ago'}
                </Box>
              ))}
            </Box>
            <Box sx={{ fontSize: 11, color: C.muted, mt: 1, lineHeight: 1.7 }}>
              It sent lines earlier in this range and has sent none recently. That is a stopped process, a replica
              scaled down, or a host that cannot reach the gateway — this page cannot tell which.
            </Box>
          </Panel>
        ) : null}

        <Panel title="Reporting" hint={isFetching ? 'loading' : rows.length + ' instances'} flush minHeight={320}>
          <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse' }}>
            <TableHead cols={['Instance', 'Service', 'Environment', 'Lines', 'Errors', 'Error rate', 'Last seen']} rightFrom={3} />
            <Box component="tbody">
              {rows.length === 0 ? (
                <EmptyRow cols={7}>
                  No instance reported in this range. The client sends one by default — a service running with{' '}
                  <code>instance: false</code> will not appear here.
                </EmptyRow>
              ) : (
                rows.map((r) => {
                  const isQuiet = r.quietForMs != null && r.quietForMs > r.resolutionMs * QUIET_BUCKETS
                  return (
                    <Box
                      component="tr"
                      key={r.instance + r.service + r.env}
                      onClick={() => patchFilters({ query: 'instance:' + r.instance })}
                      sx={{ cursor: 'pointer', '&:hover': { background: C.raised } }}
                    >
                      <Cell color={isQuiet ? C.warning : C.text}>{r.instance}</Cell>
                      <Cell>{r.service}</Cell>
                      <Cell>{r.env}</Cell>
                      <Cell right>{r.lines.toLocaleString()}</Cell>
                      <Cell right color={r.errors > 0 ? C.error : C.text2}>
                        {r.errors.toLocaleString()}
                      </Cell>
                      <Cell right color={r.lines && r.errors / r.lines > 0.02 ? C.error : C.text2}>
                        {r.lines ? ((r.errors / r.lines) * 100).toFixed(1) + '%' : '—'}
                      </Cell>
                      {/* "About", because the resolution is the bucket width the
                          range was divided into, not a precise timestamp. */}
                      <Cell right color={isQuiet ? C.warning : C.text2}>
                        {r.quietForMs == null ? '—' : '~' + age(r.quietForMs) + ' ago'}
                      </Cell>
                    </Box>
                  )
                })
              )}
            </Box>
          </Box>
        </Panel>
      </Box>
    </Box>
  )
}
