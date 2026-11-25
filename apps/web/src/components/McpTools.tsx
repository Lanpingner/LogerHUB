'use client'

import Box from '@mui/material/Box'
import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useConsole } from '../store/console'
import { C } from '../lib/tokens'
import type { SearchResponse } from '../lib/types'
import { TimeRangeSelector } from './TimeRangeSelector'
import { Panel } from './Panel'
import { Cell } from './LogExplorer'
import { useStatusFacts } from './status-context'

/** One row per tool, the way Endpoints gives one row per route. The two pages
 *  are deliberately the same table: a tool call and an HTTP request are the same
 *  shape of thing — a named operation with a duration and an outcome — and an
 *  operator comparing them should not have to learn two layouts. */
interface ToolRow {
  application: string
  role: string
  server: string
  tool: string
  n: number
  errors: number
  durations: number[]
  last: number
  avg: number
  p95: number
  p99: number
  max: number
}

export function McpTools() {
  const { range, patchFilters } = useConsole()
  const publish = useStatusFacts()
  const { data, isFetching } = useQuery<SearchResponse>({
    // `kind:mcp` is a structured-metadata term, so the gateway's promotion of
    // `kind` is what makes this a server-side filter rather than a scan.
    queryKey: ['mcp-tools', range],
    queryFn: async () => {
      const res = await fetch('/api/search?range=' + range + '&limit=2000&q=' + encodeURIComponent('kind:mcp'))
      if (!res.ok) throw new Error(String(res.status))
      return res.json()
    },
    refetchInterval: 60_000,
  })

  const rows = useMemo<ToolRow[]>(() => {
    const groups = new Map<string, Omit<ToolRow, 'avg' | 'p95' | 'p99' | 'max'>>()
    for (const r of data?.rows ?? []) {
      // A row with no tool name is not a tool call we can group. It would
      // otherwise collect every malformed entry into one meaningless row.
      if (!r.tool) continue
      const role = r.mcpRole ?? '-'
      const server = r.mcpServer ?? '-'
      const key = r.application + '\u0000' + role + '\u0000' + server + '\u0000' + r.tool
      const g = groups.get(key) ?? {
        application: r.application,
        role,
        server,
        tool: r.tool,
        n: 0,
        errors: 0,
        durations: [],
        last: 0,
      }
      g.n++
      // `ok === false` only. An absent `ok` means the client did not report an
      // outcome, and counting that as a failure would invent errors.
      if (r.ok === false) g.errors++
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

  const totalCalls = useMemo(() => rows.reduce((n, r) => n + r.n, 0), [rows])

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
        <Box sx={{ fontSize: 13, fontWeight: 600 }}>MCP Tools</Box>
        <Box sx={{ fontSize: 11, color: C.muted }}>
          {totalCalls.toLocaleString()} tool calls in this range, from {(data?.rows.length ?? 0).toLocaleString()} sampled
          lines
        </Box>
        <Box sx={{ flex: 1 }} />
        <TimeRangeSelector />
      </Box>
      <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
        <Panel title="Tools" hint={isFetching ? 'loading' : rows.length + ' tools'} flush minHeight={320}>
          <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse' }}>
            <Box component="thead" sx={{ position: 'sticky', top: 0, background: C.raised, zIndex: 1 }}>
              <Box component="tr">
                {['Application', 'Role', 'Server', 'Tool', 'Calls', 'Failure rate', 'Avg', 'P95', 'P99', 'Max', 'Last seen'].map(
                  (h, i) => (
                    <Box
                      component="th"
                      key={h}
                      sx={{
                        textAlign: i > 3 ? 'right' : 'left',
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
                  ),
                )}
              </Box>
            </Box>
            <Box component="tbody">
              {rows.length === 0 ? (
                <Box component="tr">
                  <Box component="td" colSpan={11} sx={{ px: 1.5, py: 2, fontSize: 11.5, color: C.muted }}>
                    No MCP tool calls in this range. Wrap a handler with <code>log.wrapMcpTool()</code>, or an outbound
                    call with <code>log.wrapMcpClient()</code>, and they appear here.
                  </Box>
                </Box>
              ) : (
                rows.map((r) => (
                  <Box
                    component="tr"
                    key={r.application + r.role + r.server + r.tool}
                    // Same gesture as Endpoints: clicking a row hands the
                    // explorer a query that selects exactly these lines.
                    onClick={() =>
                      patchFilters({ query: 'tool:' + r.tool, application: r.application, service: r.application })
                    }
                    sx={{ cursor: 'pointer', '&:hover': { background: C.raised } }}
                  >
                    <Cell>{r.application}</Cell>
                    <Cell color={r.role === 'server' ? C.accent : C.info}>
                      {r.role === 'server' ? 'TOOL' : r.role === 'client' ? 'CALL' : r.role}
                    </Cell>
                    <Cell>{r.server}</Cell>
                    <Cell color={C.text}>{r.tool}</Cell>
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
