'use client'

import Box from '@mui/material/Box'
import Tooltip from '@mui/material/Tooltip'
import { C, MONO } from '../lib/tokens'
import type { Bucket } from '../lib/types'

export interface Metric {
  label: string
  value: string
  tone?: string
  hint?: string
  spark?: number[]
  /** Change against the previous period, as a fraction. */
  delta?: number
  deltaGoodWhenUp?: boolean
}

function Spark({ data, tone }: { data: number[]; tone: string }) {
  if (data.length < 2) return null
  const peak = Math.max(1, ...data)
  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: '1px', height: 16, mt: 0.5 }} aria-hidden>
      {data.slice(-28).map((v, i) => (
        <Box
          key={i}
          sx={{
            width: 2,
            flex: 'none',
            height: Math.max(1, Math.round((v / peak) * 16)),
            background: v ? tone : C.border,
            opacity: v ? 0.75 : 1,
          }}
        />
      ))}
    </Box>
  )
}

/** A compact horizontal strip rather than a row of large cards: these are
 *  headline numbers, and a card each would push the panels below the fold. */
export function MetricStrip({ metrics }: { metrics: Metric[] }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))',
        borderBottom: '1px solid ' + C.border,
        background: C.panel,
        flex: 'none',
      }}
    >
      {metrics.map((m, i) => (
        <Box
          key={m.label}
          sx={{
            px: 2.5,
            py: 1.5,
            borderRight: i === metrics.length - 1 ? 'none' : '1px solid ' + C.border,
            minWidth: 0,
          }}
        >
          <Box sx={{ fontSize: 10.5, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {m.label}
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
            <Tooltip title={m.hint ?? ''} disableHoverListener={!m.hint}>
              <Box
                sx={{
                  fontFamily: MONO,
                  fontSize: 22,
                  fontWeight: 500,
                  letterSpacing: '-0.02em',
                  color: m.tone ?? C.text,
                  lineHeight: 1.25,
                }}
              >
                {m.value}
              </Box>
            </Tooltip>
            {m.delta != null && Number.isFinite(m.delta) ? (
              <Box
                sx={{
                  fontFamily: MONO,
                  fontSize: 10.5,
                  color:
                    m.delta === 0
                      ? C.muted
                      : (m.delta > 0) === (m.deltaGoodWhenUp ?? true)
                        ? C.success
                        : C.error,
                }}
              >
                {m.delta > 0 ? '+' : ''}
                {(m.delta * 100).toFixed(0)}%
              </Box>
            ) : null}
          </Box>
          {m.spark ? <Spark data={m.spark} tone={m.tone ?? C.info} /> : null}
        </Box>
      ))}
    </Box>
  )
}

export function bucketsToSpark(buckets: Bucket[], pick: 'total' | 'errors' = 'total'): number[] {
  return buckets.map((b) => (pick === 'total' ? b.total : b.errors))
}
