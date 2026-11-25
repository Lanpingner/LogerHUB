'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import IconButton from '@mui/material/IconButton'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Tooltip from '@mui/material/Tooltip'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart3,
  Columns3,
  Download,
  Eraser,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  ArrowDownToLine,
  TerminalSquare,
  Table2,
} from 'lucide-react'
import { DEFAULT_COLUMNS, useConsole, type ColumnKey } from '../store/console'
import { C, MONO } from '../lib/tokens'
import { matches, parse } from '@logguber/shared'
import type { Bucket, LogRow, SearchResponse } from '../lib/types'
import { QueryEditor } from './QueryEditor'
import { TrafficHistogram } from './TrafficHistogram'
import { LogDataGrid, RawLogStream } from './LogDataGrid'
import { RequestInspector } from './RequestInspector'
import { useStatusFacts } from './status-context'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']
const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx']
const LEVELS = ['debug', 'info', 'warn', 'error', 'fatal']
const MAX_ROWS = 2000
/** How often buffered arrivals are applied to the view. Ten renders a second
 *  reads as continuous to the eye and is an order of magnitude cheaper than
 *  rendering each line. */
const FLUSH_MS = 100

interface LiveEntry {
  ts: string
  level: string
  kind?: string
  msg: string
  service: string
  env: string
  dims?: Record<string, string>
  meta?: Record<string, unknown>
  source_ip?: string
}

function toRow(e: LiveEntry, seq: number): LogRow {
  const http = (e.meta?.http ?? {}) as Record<string, unknown>
  const num = (v: unknown) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return {
    id: 'live-' + seq,
    ts: Date.parse(e.ts) || Date.now(),
    level: e.level,
    application: e.service,
    service: e.service,
    env: e.env,
    method: http.method as string | undefined,
    path: (http.path ?? http.route) as string | undefined,
    route: http.route as string | undefined,
    status: num(http.status),
    duration: num(http.duration_ms),
    company: e.dims?.company_id,
    user: e.dims?.user_id,
    apiKey: e.dims?.api_key_id,
    requestId: http.request_id as string | undefined,
    traceId: e.dims?.trace_id,
    instance: e.dims?.instance,
    sourceIp: e.source_ip,
    msg: e.msg,
    // `_source_ip` matches what the stored line carries, so the Raw JSON tab
    // reads the same for a live row and the same row fetched back from Loki.
    payload: { msg: e.msg, ...(e.meta ?? {}), ...(e.source_ip ? { _source_ip: e.source_ip } : {}) },
  }
}

export function LiveConsole() {
  const {
    filters,
    patchFilters,
    range,
    streaming,
    setStreaming,
    autoScroll,
    setAutoScroll,
    rawMode,
    setRawMode,
    histogramOpen,
    toggleHistogram,
    columns,
    setColumns,
    inspectorWidth,
    setInspectorWidth,
  } = useConsole()

  const publish = useStatusFacts()
  const [rows, setRows] = useState<LogRow[]>([])
  const [selected, setSelected] = useState<LogRow | null>(null)
  // Stable, so the memoised inspector is not re-rendered by the stream.
  const clearSelected = useCallback(() => setSelected(null), [])
  const [state, setState] = useState<'connecting' | 'live' | 'lost'>('connecting')
  const [pendingCount, setPendingCount] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  const [colMenu, setColMenu] = useState<HTMLElement | null>(null)
  const [draft, setDraft] = useState(filters.query)
  const [applied, setApplied] = useState(filters.query)

  const seq = useRef(0)
  const arrivals = useRef(0)
  /** Lines that have arrived since the last flush, oldest first, and the
   *  "new lines" badge count owed to the user. Both are refs so an arrival
   *  costs no render of its own. */
  const waiting = useRef<LogRow[]>([])
  const waitingCount = useRef(0)
  const [rate, setRate] = useState(0)
  const streamingRef = useRef(streaming)
  streamingRef.current = streaming
  const autoScrollRef = useRef(autoScroll)
  autoScrollRef.current = autoScroll

  const compiled = useMemo(() => parse(applied), [applied])

  // Arrival rate for the status bar, averaged over the last second.
  useEffect(() => {
    const t = setInterval(() => {
      setRate(arrivals.current)
      arrivals.current = 0
    }, 1000)
    return () => clearInterval(t)
  }, [])

  const liveUrl = useMemo(() => {
    const p = new URLSearchParams()
    if (filters.service) p.set('services', filters.service)
    if (filters.environment) p.set('envs', filters.environment)
    if (filters.levels.length) p.set('levels', filters.levels.join(','))
    return '/api/live' + (p.toString() ? '?' + p.toString() : '')
  }, [filters.service, filters.environment, filters.levels])

  useEffect(() => {
    const es = new EventSource(liveUrl)
    es.onopen = () => setState('live')
    es.onerror = () => setState('lost')
    es.onmessage = (ev) => {
      arrivals.current++
      // Pausing stops the view updating, never the gateway's ingestion.
      if (!streamingRef.current) {
        waitingCount.current++
        return
      }
      try {
        waiting.current.push(toRow(JSON.parse(ev.data) as LiveEntry, seq.current++))
        if (!autoScrollRef.current) waitingCount.current++
      } catch {
        // A malformed frame is skipped rather than breaking the stream.
      }
    }
    // Arrivals are applied in batches rather than one render each. A service
    // under load delivers hundreds of lines a second, and every render refilters
    // the whole buffer and redraws the grid and the inspector; at FLUSH_MS the
    // view costs the same whether 1 line or 500 arrived in that window.
    const flush = setInterval(() => {
      const batch = waiting.current
      const bumped = waitingCount.current
      if (batch.length === 0 && bumped === 0) return
      waiting.current = []
      waitingCount.current = 0
      if (batch.length > 0) {
        setRows((prev) => {
          // The buffer is oldest-first; the view reads newest-first.
          const next = batch.length === 1 ? [batch[0], ...prev] : batch.reverse().concat(prev)
          return next.length > MAX_ROWS ? next.slice(0, MAX_ROWS) : next
        })
      }
      if (bumped > 0) setPendingCount((n) => n + bumped)
    }, FLUSH_MS)
    return () => {
      es.close()
      clearInterval(flush)
      waiting.current = []
      waitingCount.current = 0
    }
  }, [liveUrl])

  useEffect(() => {
    // Resuming clears the badge, including any count buffered but not yet
    // flushed, or the next flush would put the badge straight back.
    if (streaming && autoScroll) {
      waitingCount.current = 0
      setPendingCount(0)
    }
  }, [streaming, autoScroll])

  // Histogram comes from the pre-aggregated counters, so it covers the whole
  // range rather than only what this session has seen.
  const { data: history } = useQuery<SearchResponse>({
    queryKey: ['search-buckets', range, filters.service],
    queryFn: async () => {
      const p = new URLSearchParams({ range, limit: '1500' })
      if (filters.service) p.set('service', filters.service)
      const res = await fetch('/api/search?' + p.toString())
      if (!res.ok) throw new Error(String(res.status))
      return res.json()
    },
    refetchInterval: 30_000,
    enabled: histogramOpen,
  })

  const visible = useMemo(() => {
    let out = rows
    if (compiled.query.or.length) {
      out = out.filter((r) =>
        matches(
          {
            service: r.service,
            env: r.env,
            level: r.level,
            msg: r.msg,
            dims: {
              company_id: r.company ?? '',
              user_id: r.user ?? '',
              api_key_id: r.apiKey ?? '',
              request_id: r.requestId ?? '',
              trace_id: r.traceId ?? '',
              instance: r.instance ?? '',
            },
            meta: r.payload ?? {},
          },
          compiled.query,
        ),
      )
    }
    if (filters.methods.length) out = out.filter((r) => r.method && filters.methods.includes(r.method))
    if (filters.statusClasses.length) {
      out = out.filter((r) => r.status != null && filters.statusClasses.includes(Math.floor(r.status / 100) + 'xx'))
    }
    if (filters.levels.length) out = out.filter((r) => filters.levels.includes(r.level))
    return out
  }, [rows, compiled.query, filters.methods, filters.statusClasses, filters.levels])

  useEffect(() => {
    publish({
      matching: visible.length,
      ingestRate: rate,
      connection: state === 'live' ? (streaming ? 'live' : 'paused') : state,
    })
  }, [publish, visible.length, rate, state, streaming])

  const exportJson = useCallback(() => {
    const blob = new Blob([JSON.stringify(visible, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'logerhub-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') + '.json'
    a.click()
    URL.revokeObjectURL(url)
  }, [visible])

  // Inspector resize
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    if (!dragging) return
    const move = (e: PointerEvent) => setInspectorWidth(window.innerWidth - e.clientX)
    const up = () => setDragging(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [dragging, setInspectorWidth])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selected) setSelected(null)
      const typing =
        e.target instanceof HTMLElement &&
        (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)
      if (typing || !visible.length) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const i = selected ? visible.findIndex((r) => r.id === selected.id) : -1
        const next = e.key === 'ArrowDown' ? Math.min(visible.length - 1, i + 1) : Math.max(0, i - 1)
        setSelected(visible[next])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, visible])

  const buckets: Bucket[] = history?.buckets ?? []

  return (
    <Box
      sx={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        ...(fullscreen
          ? { position: 'fixed', inset: 0, zIndex: 1200, background: C.bg }
          : {}),
      }}
    >
      {/* toolbar */}
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

        <Tooltip title={streaming ? 'Pause the view · Space' : 'Resume · Space'}>
          <Button
            onClick={() => setStreaming(!streaming)}
            startIcon={streaming ? <Pause size={12} /> : <Play size={12} />}
            sx={{ color: streaming ? C.text : C.accent, borderColor: streaming ? C.border : C.accent }}
          >
            {streaming ? 'Pause' : 'Resume'}
          </Button>
        </Tooltip>

        <Tooltip title="Follow new lines">
          <Button
            onClick={() => setAutoScroll(!autoScroll)}
            startIcon={<ArrowDownToLine size={12} />}
            sx={{
              color: autoScroll ? C.accent : C.text2,
              borderColor: autoScroll ? 'rgba(74,222,128,0.4)' : C.border,
              background: autoScroll ? C.selected : 'transparent',
            }}
          >
            Follow
          </Button>
        </Tooltip>

        <Tooltip title="Clear the view. Ingestion keeps running.">
          <Button
            onClick={() => {
              setRows([])
              setSelected(null)
              setPendingCount(0)
            }}
            startIcon={<Eraser size={12} />}
          >
            Clear
          </Button>
        </Tooltip>

        <Select
          multiple
          value={filters.methods}
          onChange={(e) => patchFilters({ methods: e.target.value as string[] })}
          displayEmpty
          renderValue={(v) => ((v as string[]).length ? (v as string[]).join(',') : 'method')}
          sx={{ height: 26, minWidth: 92, fontSize: 11, fontFamily: MONO }}
        >
          {METHODS.map((m) => (
            <MenuItem key={m} value={m} dense>
              <Checkbox checked={filters.methods.includes(m)} size="small" sx={{ mr: 1 }} />
              {m}
            </MenuItem>
          ))}
        </Select>

        <Select
          multiple
          value={filters.statusClasses}
          onChange={(e) => patchFilters({ statusClasses: e.target.value as string[] })}
          displayEmpty
          renderValue={(v) => ((v as string[]).length ? (v as string[]).join(',') : 'status')}
          sx={{ height: 26, minWidth: 86, fontSize: 11, fontFamily: MONO }}
        >
          {STATUS_CLASSES.map((s) => (
            <MenuItem key={s} value={s} dense>
              <Checkbox checked={filters.statusClasses.includes(s)} size="small" sx={{ mr: 1 }} />
              {s}
            </MenuItem>
          ))}
        </Select>

        <Select
          multiple
          value={filters.levels}
          onChange={(e) => patchFilters({ levels: e.target.value as string[] })}
          displayEmpty
          renderValue={(v) => ((v as string[]).length ? (v as string[]).join(',') : 'level')}
          sx={{ height: 26, minWidth: 86, fontSize: 11, fontFamily: MONO }}
        >
          {LEVELS.map((l) => (
            <MenuItem key={l} value={l} dense>
              <Checkbox checked={filters.levels.includes(l)} size="small" sx={{ mr: 1 }} />
              {l}
            </MenuItem>
          ))}
        </Select>

        <Box sx={{ flex: 1 }} />

        <Tooltip title={rawMode ? 'Table view' : 'Raw terminal output'}>
          <IconButton onClick={() => setRawMode(!rawMode)} aria-label="Toggle raw output">
            {rawMode ? <Table2 size={14} /> : <TerminalSquare size={14} />}
          </IconButton>
        </Tooltip>
        <Tooltip title="Columns">
          <IconButton onClick={(e) => setColMenu(e.currentTarget)} aria-label="Configure columns">
            <Columns3 size={14} />
          </IconButton>
        </Tooltip>
        <Tooltip title={histogramOpen ? 'Hide histogram' : 'Show histogram'}>
          <IconButton onClick={toggleHistogram} aria-label="Toggle histogram">
            <BarChart3 size={14} color={histogramOpen ? C.accent : undefined} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Export what is on screen as JSON">
          <IconButton onClick={exportJson} aria-label="Export">
            <Download size={14} />
          </IconButton>
        </Tooltip>
        <Tooltip title={fullscreen ? 'Leave fullscreen' : 'Fullscreen'}>
          <IconButton onClick={() => setFullscreen(!fullscreen)} aria-label="Fullscreen">
            {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </IconButton>
        </Tooltip>
      </Box>

      <Menu anchorEl={colMenu} open={Boolean(colMenu)} onClose={() => setColMenu(null)}>
        {DEFAULT_COLUMNS.map((key) => (
          <MenuItem
            key={key}
            dense
            onClick={() =>
              setColumns(
                columns.includes(key)
                  ? (columns.filter((c) => c !== key) as ColumnKey[])
                  : (DEFAULT_COLUMNS.filter((c) => columns.includes(c) || c === key) as ColumnKey[]),
              )
            }
          >
            <Checkbox checked={columns.includes(key)} size="small" sx={{ mr: 1 }} />
            {key}
          </MenuItem>
        ))}
      </Menu>

      {histogramOpen ? (
        <Box sx={{ flex: 'none', borderBottom: '1px solid ' + C.border, background: C.panel, px: 1, pt: 1 }}>
          <Box sx={{ px: 1, fontSize: 10, color: C.muted }}>Traffic over {range}</Box>
          <TrafficHistogram buckets={buckets} height={84} />
        </Box>
      ) : null}

      <Box sx={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          {state === 'lost' ? (
            <Box
              sx={{
                px: 2,
                py: 1,
                background: 'rgba(248,113,113,0.08)',
                borderBottom: '1px solid ' + C.error,
                fontSize: 11.5,
                color: C.error,
              }}
            >
              Live stream disconnected. Your services keep logging and spool to disk, so nothing is lost — lines
              replay when the gateway returns.
            </Box>
          ) : null}

          {pendingCount > 0 && (!streaming || !autoScroll) ? (
            <Box
              role="button"
              tabIndex={0}
              onClick={() => {
                setStreaming(true)
                setAutoScroll(true)
                setPendingCount(0)
              }}
              sx={{
                position: 'absolute',
                bottom: 14,
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 5,
                px: 2,
                height: 24,
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                background: C.selected,
                border: '1px solid rgba(74,222,128,0.45)',
                borderRadius: '12px',
                fontSize: 11,
                color: C.accent,
                cursor: 'pointer',
                fontFamily: MONO,
              }}
            >
              {pendingCount.toLocaleString()} new {pendingCount === 1 ? 'line' : 'lines'} — resume
            </Box>
          ) : null}

          <Box sx={{ flex: 1, minHeight: 0 }}>
            {rawMode ? (
              <RawLogStream rows={visible} />
            ) : (
              <LogDataGrid rows={visible} selectedId={selected?.id} onSelect={setSelected} />
            )}
          </Box>
        </Box>

        {selected ? (
          <>
            <Box
              onPointerDown={(e) => {
                e.preventDefault()
                setDragging(true)
              }}
              role="separator"
              aria-label="Resize inspector"
              sx={{
                width: 4,
                cursor: 'col-resize',
                flex: 'none',
                background: dragging ? C.accent : C.border,
                '&:hover': { background: 'rgba(74,222,128,0.35)' },
              }}
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
