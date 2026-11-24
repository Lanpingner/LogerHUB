'use client'

import Box from '@mui/material/Box'
import { useConsole } from '../store/console'
import { C, TIME_RANGES } from '../lib/tokens'

/** Presets as a compact segmented row: nobody fights a calendar for "last hour". */
export function TimeRangeSelector({ compact = false }: { compact?: boolean }) {
  const { range, setRange } = useConsole()
  const shown = compact ? TIME_RANGES.filter((r) => r.minutes <= 1440) : TIME_RANGES
  return (
    <Box sx={{ display: 'flex', border: '1px solid ' + C.border, borderRadius: '4px', overflow: 'hidden', flex: 'none' }}>
      {shown.map((r) => (
        <Box
          key={r.key}
          role="button"
          tabIndex={0}
          onClick={() => setRange(r.key)}
          onKeyDown={(e) => (e.key === 'Enter' ? setRange(r.key) : undefined)}
          sx={{
            px: 1.75,
            height: 24,
            display: 'grid',
            placeItems: 'center',
            fontSize: 11,
            cursor: 'pointer',
            color: range === r.key ? C.text : C.text2,
            background: range === r.key ? C.selected : 'transparent',
            borderRight: '1px solid ' + C.border,
            '&:last-of-type': { borderRight: 'none' },
            '&:hover': { background: range === r.key ? C.selected : C.raised },
          }}
        >
          {r.key}
        </Box>
      ))}
    </Box>
  )
}
