'use client'

import Box from '@mui/material/Box'
import Tooltip from '@mui/material/Tooltip'
import { C, METHOD_COLOR, MONO, latencyColor, levelColor, statusColor } from '../lib/tokens'

export function HttpMethodIndicator({ method }: { method?: string }) {
  if (!method) return <Dash />
  const color = METHOD_COLOR[method.toUpperCase()] ?? C.muted
  return (
    <Box component="span" sx={{ fontFamily: MONO, fontSize: 11, fontWeight: 600, color }}>
      {method.toUpperCase()}
    </Box>
  )
}

export function StatusCodeIndicator({ status }: { status?: number }) {
  if (status == null) return <Dash />
  return (
    <Box
      component="span"
      sx={{
        fontFamily: MONO,
        fontSize: 11,
        fontWeight: 600,
        color: statusColor(status),
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.5,
      }}
    >
      <Box component="span" sx={{ width: 5, height: 5, borderRadius: '50%', background: statusColor(status) }} />
      {status}
    </Box>
  )
}

export function LatencyIndicator({ ms }: { ms?: number }) {
  if (ms == null) return <Dash />
  const text = ms >= 1000 ? (ms / 1000).toFixed(ms >= 10000 ? 0 : 2) + 's' : Math.round(ms) + 'ms'
  return (
    <Box component="span" sx={{ fontFamily: MONO, fontSize: 11, color: latencyColor(ms) }}>
      {text}
    </Box>
  )
}

export function LevelIndicator({ level }: { level: string }) {
  return (
    <Box component="span" sx={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 600, color: levelColor(level) }}>
      {level.toUpperCase()}
    </Box>
  )
}

export function HealthDot({
  health,
  title,
}: {
  health: 'ok' | 'warn' | 'bad' | 'idle'
  title?: string
}) {
  const color =
    health === 'ok' ? C.success : health === 'warn' ? C.warning : health === 'bad' ? C.error : C.muted
  const dot = (
    <Box
      component="span"
      sx={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: color,
        flex: 'none',
        boxShadow: health === 'bad' ? '0 0 0 2px rgba(248,113,113,0.18)' : undefined,
      }}
    />
  )
  return title ? (
    <Tooltip title={title} placement="right">
      {dot}
    </Tooltip>
  ) : (
    dot
  )
}

export function ConnectionIndicator({ state }: { state: 'live' | 'paused' | 'connecting' | 'lost' }) {
  const map = {
    live: { color: C.success, text: 'Live' },
    paused: { color: C.warning, text: 'Paused' },
    connecting: { color: C.info, text: 'Connecting' },
    lost: { color: C.error, text: 'Disconnected' },
  } as const
  const { color, text } = map[state]
  return (
    <Box
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 1,
        px: 1.5,
        height: 22,
        border: '1px solid ' + C.border,
        borderRadius: '3px',
        fontSize: 11,
        color,
        background: state === 'live' ? C.selected : 'transparent',
        borderColor: state === 'live' ? 'rgba(74,222,128,0.35)' : C.border,
      }}
    >
      <Box
        component="span"
        sx={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: color,
          animation: state === 'live' ? 'lhPulse 2s ease-in-out infinite' : 'none',
          '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
        }}
      />
      {text}
    </Box>
  )
}

/** Where the HTTP method goes on an MCP row. `server` means we served the call,
 *  `client` means we made it — the distinction an operator needs first, because
 *  a failure means something different on each side. */
export function McpRoleIndicator({ role }: { role?: string }) {
  if (!role) return <Dash />
  const served = role === 'server'
  return (
    <Box
      component="span"
      sx={{ fontFamily: MONO, fontSize: 11, fontWeight: 600, color: served ? C.accent : C.info }}
    >
      {served ? 'TOOL' : role === 'client' ? 'CALL' : role.toUpperCase()}
    </Box>
  )
}

/** Where the status code goes on an MCP row. MCP has no status codes: a call
 *  either succeeded or did not, and an absent flag is unknown rather than ok. */
export function McpOutcomeIndicator({ ok }: { ok?: boolean }) {
  if (ok == null) return <Dash />
  const color = ok ? C.success : C.error
  return (
    <Box
      component="span"
      sx={{ fontFamily: MONO, fontSize: 11, fontWeight: 600, color, display: 'inline-flex', alignItems: 'center', gap: 0.5 }}
    >
      <Box component="span" sx={{ width: 5, height: 5, borderRadius: '50%', background: color }} />
      {ok ? 'ok' : 'error'}
    </Box>
  )
}

function Dash() {
  return (
    <Box component="span" sx={{ color: C.muted, fontFamily: MONO, fontSize: 11 }}>
      —
    </Box>
  )
}
