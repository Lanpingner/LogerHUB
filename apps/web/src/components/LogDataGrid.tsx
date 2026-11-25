'use client'

import Box from '@mui/material/Box'
import { DataGrid, type GridColDef } from '@mui/x-data-grid'
import { useMemo, type CSSProperties } from 'react'
import type { LogRow } from '../lib/types'
import { useConsole, type ColumnKey } from '../store/console'
import { C, MONO, levelColor, statusColor } from '../lib/tokens'
import { HttpMethodIndicator, LatencyIndicator, LevelIndicator, StatusCodeIndicator } from './indicators'

function hms(ts: number): string {
  const d = new Date(ts)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3)
}

const mono = (v: unknown) => (
  <Box component="span" sx={{ fontFamily: MONO, fontSize: 11, color: C.text2 }}>
    {v == null || v === '' ? '—' : String(v)}
  </Box>
)

/** Dense, virtualized log table. Columns are driven by the persisted store so
 *  show/hide and width survive a reload. */
export function LogDataGrid({
  rows,
  selectedId,
  onSelect,
  loading,
}: {
  rows: LogRow[]
  selectedId?: string
  onSelect: (row: LogRow) => void
  loading?: boolean
}) {
  const { columns: visible } = useConsole()

  const all = useMemo<Record<ColumnKey, GridColDef<LogRow>>>(
    () => ({
      ts: {
        field: 'ts',
        headerName: 'Time',
        width: 108,
        sortable: false,
        renderCell: (p) => (
          <Box component="span" sx={{ fontFamily: MONO, fontSize: 11, color: C.text2 }}>
            {hms(p.row.ts)}
          </Box>
        ),
      },
      level: {
        field: 'level',
        headerName: 'Level',
        width: 58,
        sortable: false,
        renderCell: (p) => <LevelIndicator level={p.row.level} />,
      },
      application: {
        field: 'application',
        headerName: 'Application',
        width: 110,
        sortable: false,
        renderCell: (p) => (
          <Box component="span" sx={{ fontFamily: MONO, fontSize: 11, color: C.text }}>
            {p.row.application}
          </Box>
        ),
      },
      service: { field: 'service', headerName: 'Service', width: 110, sortable: false, renderCell: (p) => mono(p.row.service) },
      method: {
        field: 'method',
        headerName: 'Method',
        width: 70,
        sortable: false,
        renderCell: (p) => <HttpMethodIndicator method={p.row.method} />,
      },
      path: {
        field: 'path',
        headerName: 'Path',
        flex: 1,
        minWidth: 180,
        sortable: false,
        renderCell: (p) => (
          <Box
            component="span"
            sx={{ fontFamily: MONO, fontSize: 11.5, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {p.row.path ?? p.row.msg}
          </Box>
        ),
      },
      status: {
        field: 'status',
        headerName: 'Status',
        width: 72,
        sortable: false,
        renderCell: (p) => <StatusCodeIndicator status={p.row.status} />,
      },
      duration: {
        field: 'duration',
        headerName: 'Duration',
        width: 78,
        sortable: false,
        align: 'right',
        headerAlign: 'right',
        renderCell: (p) => <LatencyIndicator ms={p.row.duration} />,
      },
      company: { field: 'company', headerName: 'Company', width: 92, sortable: false, renderCell: (p) => mono(p.row.company) },
      user: { field: 'user', headerName: 'User', width: 80, sortable: false, renderCell: (p) => mono(p.row.user) },
      request_id: {
        field: 'requestId',
        headerName: 'Request',
        width: 104,
        sortable: false,
        renderCell: (p) => mono(p.row.requestId),
      },
      instance: { field: 'instance', headerName: 'Instance', width: 92, sortable: false, renderCell: (p) => mono(p.row.instance) },
    }),
    [],
  )

  const columns = useMemo(() => visible.map((k) => all[k]).filter(Boolean), [visible, all])

  return (
    <DataGrid
      rows={rows}
      columns={columns}
      loading={loading}
      getRowId={(r) => r.id}
      rowHeight={30}
      columnHeaderHeight={30}
      hideFooter
      disableColumnMenu
      disableRowSelectionOnClick={false}
      onRowClick={(p) => onSelect(p.row)}
      rowSelectionModel={selectedId ? { type: 'include', ids: new Set([selectedId]) } : undefined}
      localeText={{ noRowsLabel: 'No matching logs' }}
      sx={{
        border: 'none',
        fontSize: 12,
        '--DataGrid-rowBorderColor': C.border,
        '& .MuiDataGrid-columnHeaders': { background: C.raised },
        '& .MuiDataGrid-columnHeader': { borderColor: C.border },
        '& .MuiDataGrid-columnHeaderTitle': { fontSize: 11, fontWeight: 500, color: C.text2 },
        '& .MuiDataGrid-cell': { borderColor: C.border, px: 1.5, outline: 'none !important' },
        '& .MuiDataGrid-row': { cursor: 'pointer' },
        '& .MuiDataGrid-row:hover': { background: C.raised },
        '& .MuiDataGrid-row.Mui-selected': { background: C.selected },
        '& .MuiDataGrid-row.Mui-selected:hover': { background: C.selected },
        '& .MuiDataGrid-filler': { display: 'none' },
        '& .MuiDataGrid-scrollbarFiller': { background: C.raised },
        '& .MuiDataGrid-overlay': { background: 'transparent', color: C.muted, fontSize: 12 },
      }}
      getRowClassName={(p) =>
        (p.row.status ?? 0) >= 500 ? 'lh-row-error' : (p.row.status ?? 0) >= 400 ? 'lh-row-warn' : ''
      }
      slotProps={{ loadingOverlay: { variant: 'linear-progress', noRowsVariant: 'skeleton' } }}
    />
  )
}

/* Plain DOM and hoisted style objects below, deliberately, rather than the
 * `Box`/`sx` used everywhere else in this file. This list is not virtualized:
 * it renders every row it is given, up to 2000, at eight elements each. With
 * `Box` that is ~16k emotion serializations per render, measured at 352ms for
 * 2000 rows — unusable in the live view, which re-renders as lines arrive.
 * Static styles cost nothing to re-apply; the two colour-bearing ones are
 * looked up from small maps instead of being rebuilt per row. */
const RAW_ROW: CSSProperties = { whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
const RAW_MUTED: CSSProperties = { color: C.muted }
const RAW_TEXT: CSSProperties = { color: C.text }
const RAW_TEXT2: CSSProperties = { color: C.text2 }
const RAW_METHOD: CSSProperties = { color: C.info }

const levelStyles = new Map<string, CSSProperties>()
function levelStyle(level: string): CSSProperties {
  let s = levelStyles.get(level)
  if (s === undefined) {
    s = { color: levelColor(level), fontWeight: 600 }
    levelStyles.set(level, s)
  }
  return s
}

const statusStyles = new Map<number, CSSProperties>()
function statusStyle(status: number): CSSProperties {
  const klass = Math.floor(status / 100)
  let s = statusStyles.get(klass)
  if (s === undefined) {
    s = { color: statusColor(status), fontWeight: 600 }
    statusStyles.set(klass, s)
  }
  return s
}

/** How many lines the raw view draws. It has no virtualization — variable line
 *  heights from `pre-wrap` rule out the simple kind — so the row count is the
 *  cost, at eight elements each. The table view is virtualized and still holds
 *  the full buffer, so nothing here is unreachable. */
const RAW_MAX = 500

/** Raw terminal output, for people who would rather read a stream than a table. */
export function RawLogStream({ rows }: { rows: LogRow[] }) {
  const shown = rows.length > RAW_MAX ? rows.slice(0, RAW_MAX) : rows
  return (
    <Box
      sx={{
        height: '100%',
        overflow: 'auto',
        fontFamily: MONO,
        fontSize: 11.5,
        lineHeight: 1.65,
        px: 2,
        py: 1,
        background: C.bg,
      }}
    >
      {rows.length === 0 ? <Box sx={{ color: C.muted }}>No matching logs</Box> : null}
      {rows.length > RAW_MAX ? (
        <Box sx={{ color: C.muted, pb: 0.5 }}>
          {'// newest ' + RAW_MAX.toLocaleString() + ' of ' + rows.length.toLocaleString() +
            ' lines — the table view holds them all'}
        </Box>
      ) : null}
      {shown.map((r) => (
        <div key={r.id} style={RAW_ROW}>
          <span style={RAW_MUTED}>{hms(r.ts)}</span>{' '}
          <span style={levelStyle(r.level)}>{r.level.toUpperCase().padEnd(5)}</span>{' '}
          <span style={RAW_TEXT2}>{r.application.padEnd(12)}</span>{' '}
          {r.method ? <span style={RAW_METHOD}>{r.method.padEnd(5)}</span> : null}
          <span style={RAW_TEXT}>{r.path ?? r.msg}</span>{' '}
          {r.status != null ? <span style={statusStyle(r.status)}>{r.status}</span> : null}{' '}
          {r.duration != null ? <span style={RAW_MUTED}>{Math.round(r.duration)}ms</span> : null}
        </div>
      ))}
    </Box>
  )
}
