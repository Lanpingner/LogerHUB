'use client'

import Box from '@mui/material/Box'
import Tooltip from '@mui/material/Tooltip'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  Boxes,
  Database,
  Gauge,
  KeyRound,
  LayoutDashboard,
  Network,
  Route,
  ScrollText,
  Server,
  Settings,
  Siren,
  Star,
  Terminal,
  TrendingUp,
  Users,
  Workflow,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useConsole } from '../store/console'
import { C } from '../lib/tokens'
import { ServiceTree } from './ServiceTree'

interface Item {
  href: string
  label: string
  icon: LucideIcon
  ready?: boolean
}

const GROUPS: { title: string; items: Item[] }[] = [
  {
    title: 'Workspace',
    items: [
      { href: '/', label: 'Overview', icon: LayoutDashboard, ready: true },
      { href: '/live', label: 'Live Console', icon: Terminal, ready: true },
      { href: '/explorer', label: 'Log Explorer', icon: ScrollText, ready: true },
      { href: '/endpoints', label: 'API Endpoints', icon: Route, ready: true },
      { href: '/traces', label: 'Request Traces', icon: Network },
    ],
  },
  {
    title: 'Intelligence',
    items: [
      { href: '/errors', label: 'Error Intelligence', icon: AlertTriangle, ready: true },
      { href: '/performance', label: 'Performance', icon: Gauge, ready: true },
      { href: '/traffic', label: 'Traffic Analytics', icon: TrendingUp },
      { href: '/anomalies', label: 'Anomalies', icon: Activity },
      { href: '/incidents', label: 'Incidents', icon: Siren },
    ],
  },
  {
    title: 'Infrastructure',
    items: [
      { href: '/applications', label: 'Applications', icon: Boxes, ready: true },
      { href: '/services', label: 'Services', icon: Workflow },
      { href: '/instances', label: 'Instances', icon: Server },
      { href: '/environments', label: 'Environments', icon: Network },
      { href: '/sources', label: 'Data Sources', icon: Database },
    ],
  },
  {
    title: 'Management',
    items: [
      { href: '/alerts', label: 'Alerts', icon: Bell },
      { href: '/queries', label: 'Saved Queries', icon: Star, ready: true },
      { href: '/keys', label: 'API Keys', icon: KeyRound, ready: true },
      { href: '/users', label: 'Users & Permissions', icon: Users },
      { href: '/settings', label: 'Settings', icon: Settings, ready: true },
    ],
  },
]

export const NAV_ITEMS = GROUPS.flatMap((g) => g.items.map((i) => ({ ...i, group: g.title })))

export function NavigationSidebar() {
  const { sidebarCollapsed, sidebarWidth } = useConsole()
  const path = usePathname()
  const width = sidebarCollapsed ? 48 : sidebarWidth

  return (
    <Box
      component="aside"
      sx={{
        width,
        flex: 'none',
        background: C.sidebar,
        borderRight: '1px solid ' + C.border,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <Box sx={{ flex: '0 1 auto', overflowY: 'auto', overflowX: 'hidden', py: 1 }}>
        {GROUPS.map((group) => (
          <Box key={group.title} sx={{ mb: 1 }}>
            {!sidebarCollapsed ? (
              <Box
                sx={{
                  px: 3,
                  py: 1,
                  fontSize: 10,
                  letterSpacing: '0.08em',
                  color: C.muted,
                  fontWeight: 600,
                }}
              >
                {group.title.toUpperCase()}
              </Box>
            ) : (
              <Box sx={{ height: 1, background: C.border, mx: 2, my: 1.5 }} />
            )}
            {group.items.map((item) => {
              const active = item.href === '/' ? path === '/' : path.startsWith(item.href)
              const Icon = item.icon
              const row = (
                <Box
                  component={Link}
                  href={item.href}
                  key={item.href}
                  aria-current={active ? 'page' : undefined}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 2,
                    height: 28,
                    px: sidebarCollapsed ? 0 : 3,
                    justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
                    color: active ? C.text : C.text2,
                    background: active ? C.selected : 'transparent',
                    borderLeft: '2px solid ' + (active ? C.accent : 'transparent'),
                    textDecoration: 'none',
                    '&:hover': { background: active ? C.selected : C.raised, color: C.text },
                  }}
                >
                  <Icon size={14} style={{ flex: 'none', color: active ? C.accent : 'inherit' }} />
                  {!sidebarCollapsed ? (
                    <>
                      <Box component="span" sx={{ fontSize: 12, flex: 1, whiteSpace: 'nowrap' }}>
                        {item.label}
                      </Box>
                      {!item.ready ? (
                        <Box
                          component="span"
                          sx={{ fontSize: 9, color: C.muted, border: '1px solid ' + C.border, px: 0.75, borderRadius: '2px' }}
                        >
                          soon
                        </Box>
                      ) : null}
                    </>
                  ) : null}
                </Box>
              )
              return sidebarCollapsed ? (
                <Tooltip key={item.href} title={item.label} placement="right">
                  {row}
                </Tooltip>
              ) : (
                row
              )
            })}
          </Box>
        ))}
      </Box>

      {!sidebarCollapsed ? (
        <Box sx={{ flex: '1 1 auto', borderTop: '1px solid ' + C.border, overflowY: 'auto', minHeight: 120 }}>
          <Box sx={{ px: 3, py: 1, fontSize: 10, letterSpacing: '0.08em', color: C.muted, fontWeight: 600 }}>
            APPLICATIONS
          </Box>
          <ServiceTree />
        </Box>
      ) : null}
    </Box>
  )
}
