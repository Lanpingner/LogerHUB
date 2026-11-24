'use client'

import Box from '@mui/material/Box'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Tooltip from '@mui/material/Tooltip'
import IconButton from '@mui/material/IconButton'
import { usePathname } from 'next/navigation'
import { Bell, PanelLeft, Search, Settings, SquareTerminal } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useConsole } from '../store/console'
import { C, MONO, TIME_RANGES } from '../lib/tokens'
import { ConnectionIndicator } from './indicators'
import { NAV_ITEMS } from './NavigationSidebar'

export function GlobalToolbar({ email, onOpenPalette }: { email: string; onOpenPalette: () => void }) {
  const { toggleSidebar, range, setRange, filters, patchFilters, streaming } = useConsole()
  const path = usePathname()
  const here = NAV_ITEMS.find((i) => (i.href === '/' ? path === '/' : path.startsWith(i.href)))

  const { data } = useQuery<{ environments: { name: string; applications: { name: string }[] }[] }>({
    queryKey: ['tree'],
    queryFn: async () => {
      const res = await fetch('/api/tree?range=24h')
      if (!res.ok) throw new Error(String(res.status))
      return res.json()
    },
    refetchInterval: 30_000,
  })
  const envs = (data?.environments ?? []).map((e) => e.name)
  const apps = [...new Set((data?.environments ?? []).flatMap((e) => e.applications.map((a) => a.name)))]

  return (
    <Box
      component="header"
      sx={{
        height: 46,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        px: 2,
        background: C.sidebar,
        borderBottom: '1px solid ' + C.border,
      }}
    >
      <Tooltip title="Toggle sidebar · Ctrl+B">
        <IconButton onClick={toggleSidebar} aria-label="Toggle sidebar">
          <PanelLeft size={15} />
        </IconButton>
      </Tooltip>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flex: 'none' }}>
        <SquareTerminal size={17} color={C.accent} />
        <Box sx={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em' }}>LogerHub</Box>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 12, color: C.muted, flex: 'none' }}>
        <Box component="span" sx={{ color: C.border }}>
          /
        </Box>
        <Box component="span" sx={{ color: C.text2 }}>
          {filters.application || 'all applications'}
        </Box>
        <Box component="span" sx={{ color: C.border }}>
          /
        </Box>
        <Box component="span" sx={{ color: C.text }}>
          {here?.label ?? 'Console'}
        </Box>
      </Box>

      <Box
        role="button"
        tabIndex={0}
        onClick={onOpenPalette}
        onKeyDown={(e) => (e.key === 'Enter' ? onOpenPalette() : undefined)}
        sx={{
          flex: 1,
          maxWidth: 520,
          mx: 'auto',
          height: 26,
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          px: 1.5,
          background: C.raised,
          border: '1px solid ' + C.border,
          borderRadius: '4px',
          color: C.muted,
          fontSize: 12,
          cursor: 'pointer',
          '&:hover': { borderColor: '#33414f' },
        }}
      >
        <Search size={13} />
        <Box component="span" sx={{ flex: 1 }}>
          Search or jump to…
        </Box>
        <Box
          component="kbd"
          sx={{
            fontFamily: MONO,
            fontSize: 10,
            border: '1px solid ' + C.border,
            borderRadius: '3px',
            px: 0.75,
            color: C.text2,
          }}
        >
          Ctrl+K
        </Box>
      </Box>

      <Select
        value={envs.includes(filters.environment) ? filters.environment : ''}
        onChange={(e) => patchFilters({ environment: e.target.value })}
        displayEmpty
        sx={{ width: 128, height: 26, fontSize: 12, fontFamily: MONO }}
        renderValue={(v) => (v ? String(v) : 'all envs')}
      >
        <MenuItem value="">All environments</MenuItem>
        {envs.map((e) => (
          <MenuItem key={e} value={e}>
            {e}
          </MenuItem>
        ))}
      </Select>

      <Select
        value={apps.includes(filters.application) ? filters.application : ''}
        onChange={(e) => patchFilters({ application: e.target.value, service: e.target.value })}
        displayEmpty
        sx={{ width: 136, height: 26, fontSize: 12, fontFamily: MONO }}
        renderValue={(v) => (v ? String(v) : 'all apps')}
      >
        <MenuItem value="">All applications</MenuItem>
        {apps.map((a) => (
          <MenuItem key={a} value={a}>
            {a}
          </MenuItem>
        ))}
      </Select>

      <Select
        value={range}
        onChange={(e) => setRange(e.target.value)}
        sx={{ width: 150, height: 26, fontSize: 12 }}
      >
        {TIME_RANGES.map((r) => (
          <MenuItem key={r.key} value={r.key}>
            {r.label}
          </MenuItem>
        ))}
      </Select>

      <ConnectionIndicator state={streaming ? 'live' : 'paused'} />

      <Tooltip title="No notifications">
        <IconButton aria-label="Notifications">
          <Bell size={15} />
        </IconButton>
      </Tooltip>
      <Tooltip title="Settings">
        <IconButton component="a" href="/settings" aria-label="Settings">
          <Settings size={15} />
        </IconButton>
      </Tooltip>
      <Tooltip title={email}>
        <Box
          sx={{
            width: 24,
            height: 24,
            borderRadius: '3px',
            background: C.selected,
            border: '1px solid ' + C.border,
            display: 'grid',
            placeItems: 'center',
            fontSize: 11,
            color: C.accent,
            fontFamily: MONO,
            flex: 'none',
          }}
        >
          {email.slice(0, 2).toUpperCase()}
        </Box>
      </Tooltip>
    </Box>
  )
}
