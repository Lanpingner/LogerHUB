'use client'

import Box from '@mui/material/Box'
import Tooltip from '@mui/material/Tooltip'
import { useEffect, useState } from 'react'
import { useConsole } from '../store/console'
import { C, MONO } from '../lib/tokens'

export interface StatusFacts {
  matching?: number
  tookMs?: number
  ingestRate?: number
  connection?: 'live' | 'paused' | 'connecting' | 'lost'
}

/** A VS Code style status bar: the facts an operator glances at, nothing else. */
export function StatusBar({ facts }: { facts: StatusFacts }) {
  const { filters, range, toggleBottomPanel } = useConsole()
  const [now, setNow] = useState<string>('')

  useEffect(() => {
    const tick = () => setNow(new Date().toLocaleTimeString(undefined, { hour12: false }))
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [])

  const conn = facts.connection ?? 'live'
  const connColor =
    conn === 'live' ? C.success : conn === 'paused' ? C.warning : conn === 'connecting' ? C.info : C.error

  return (
    <Box
      component="footer"
      sx={{
        height: 24,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        px: 1.5,
        background: C.sidebar,
        borderTop: '1px solid ' + C.border,
        fontFamily: MONO,
        fontSize: 11,
        color: C.text2,
        userSelect: 'none',
      }}
    >
      <Cell>
        <Box component="span" sx={{ width: 6, height: 6, borderRadius: '50%', background: connColor }} />
        <Box component="span" sx={{ color: connColor }}>
          {conn}
        </Box>
      </Cell>
      <Cell>{filters.environment || 'all envs'}</Cell>
      <Cell>{filters.application || 'all apps'}</Cell>
      <Cell>{range}</Cell>
      {facts.ingestRate != null ? (
        <Tooltip title="Lines arriving per second, averaged over the last 10 seconds">
          <Box sx={{ display: 'flex' }}>
            <Cell>{facts.ingestRate.toFixed(1)}/s in</Cell>
          </Box>
        </Tooltip>
      ) : null}
      {facts.matching != null ? <Cell>{facts.matching.toLocaleString()} matching</Cell> : null}
      {facts.tookMs != null ? <Cell>{facts.tookMs} ms</Cell> : null}

      <Box sx={{ flex: 1 }} />

      <Cell onClick={toggleBottomPanel} title="Toggle the query panel · Ctrl+J">
        query panel
      </Cell>
      <Cell>Ctrl+K palette</Cell>
      <Cell>{now}</Cell>
      {/* Inlined from apps/web/package.json by next.config.mjs — never hardcode it. */}
      <Cell title="Console version">v{process.env.NEXT_PUBLIC_APP_VERSION}</Cell>
    </Box>
  )
}

function Cell({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode
  onClick?: () => void
  title?: string
}) {
  const body = (
    <Box
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => (onClick && e.key === 'Enter' ? onClick() : undefined)}
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 1,
        px: 1.5,
        height: '100%',
        cursor: onClick ? 'pointer' : 'default',
        '&:hover': onClick ? { background: C.raised, color: C.text } : undefined,
      }}
    >
      {children}
    </Box>
  )
  return title ? <Tooltip title={title}>{body}</Tooltip> : body
}
