'use client'

import Box from '@mui/material/Box'
import type { ReactNode } from 'react'
import { C, MONO } from '../lib/tokens'

/** Every analytical panel is the same frame: a 24px header strip, a hairline
 *  border and no shadow, so a dense grid of them reads as one surface. */
export function Panel({
  title,
  hint,
  action,
  children,
  span = 1,
  minHeight = 200,
  flush = false,
}: {
  title: string
  hint?: string
  action?: ReactNode
  children: ReactNode
  span?: number
  minHeight?: number
  flush?: boolean
}) {
  return (
    <Box
      sx={{
        gridColumn: 'span ' + span,
        background: C.panel,
        border: '1px solid ' + C.border,
        borderRadius: '4px',
        display: 'flex',
        flexDirection: 'column',
        minHeight,
        minWidth: 0,
        overflow: 'hidden',
      }}
    >
      <Box
        sx={{
          height: 26,
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          px: 2,
          borderBottom: '1px solid ' + C.border,
          background: C.raised,
        }}
      >
        <Box sx={{ fontSize: 11.5, fontWeight: 500, color: C.text }}>{title}</Box>
        {hint ? (
          <Box sx={{ fontSize: 10.5, color: C.muted, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {hint}
          </Box>
        ) : (
          <Box sx={{ flex: 1 }} />
        )}
        {action}
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', p: flush ? 0 : 2 }}>{children}</Box>
    </Box>
  )
}

/** Horizontal ranked bars — the honest answer to "compare these named things". */
export function RankedBars({
  rows,
  tone = C.info,
  onPick,
  unit,
}: {
  rows: { name: string; value: number; secondary?: number }[]
  tone?: string
  onPick?: (name: string) => void
  unit?: string
}) {
  if (!rows.length) {
    return <Box sx={{ fontSize: 11.5, color: C.muted, p: 1 }}>Nothing recorded in this range.</Box>
  }
  const peak = Math.max(1, ...rows.map((r) => r.value))
  return (
    <Box sx={{ display: 'grid', gap: 0.5 }}>
      {rows.map((r, i) => (
        <Box
          key={r.name + ':' + i}
          role={onPick ? 'button' : undefined}
          tabIndex={onPick ? 0 : undefined}
          onClick={() => onPick?.(r.name)}
          onKeyDown={(e) => (onPick && e.key === 'Enter' ? onPick(r.name) : undefined)}
          sx={{
            display: 'grid',
            gridTemplateColumns: 'minmax(84px, 150px) 1fr 72px',
            alignItems: 'center',
            gap: 1.5,
            height: 22,
            px: 0.5,
            borderRadius: '2px',
            cursor: onPick ? 'pointer' : 'default',
            '&:hover': onPick ? { background: C.raised } : undefined,
          }}
        >
          <Box
            sx={{
              fontFamily: MONO,
              fontSize: 11,
              color: C.text2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={r.name}
          >
            {r.name}
          </Box>
          <Box sx={{ position: 'relative', height: 12, background: C.bg, borderRadius: '2px', overflow: 'hidden' }}>
            <Box sx={{ position: 'absolute', inset: 0, width: (r.value / peak) * 100 + '%', background: tone, opacity: 0.85 }} />
            {r.secondary ? (
              <Box
                sx={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: ((r.value - r.secondary) / peak) * 100 + '%',
                  width: (r.secondary / peak) * 100 + '%',
                  background: C.error,
                }}
              />
            ) : null}
          </Box>
          <Box sx={{ fontFamily: MONO, fontSize: 11, color: C.text2, textAlign: 'right' }}>
            {r.value.toLocaleString()}
            {unit ?? ''}
          </Box>
        </Box>
      ))}
    </Box>
  )
}
