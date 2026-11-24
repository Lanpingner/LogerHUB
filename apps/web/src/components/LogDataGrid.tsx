'use client'

import Box from '@mui/material/Box'
import { DataGrid, type GridColDef } from '@mui/x-data-grid'
import { useMemo } from 'react'
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

/** Raw terminal output, for people who would rather read a stream than a table. */
export function RawLogStream({ rows }: { rows: LogRow[] }) {
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
      {rows.map((r) => (
        <Box key={r.id} sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          <Box component="span" sx={{ color: C.muted }}>
            {hms(r.ts)}
          </Box>{' '}
          <Box component="span" sx={{ color: levelColor(r.level), fontWeight: 600 }}>
            {r.level.toUpperCase().padEnd(5)}
          </Box>{' '}
          <Box component="span" sx={{ color: C.text2 }}>
            {r.application.padEnd(12)}
          </Box>{' '}
          {r.method ? (
            <Box component="span" sx={{ color: C.info }}>
              {r.method.padEnd(5)}
            </Box>
          ) : null}
          <Box component="span" sx={{ color: C.text }}>
            {r.path ?? r.msg}
          </Box>{' '}
          {r.status != null ? (
            <Box component="span" sx={{ color: statusColor(r.status), fontWeight: 600 }}>
              {r.status}
            </Box>
          ) : null}{' '}
          {r.duration != null ? (
            <Box component="span" sx={{ color: C.muted }}>
              {Math.round(r.duration)}ms
            </Box>
          ) : null}
        </Box>
      ))}
    </Box>
  )
}
