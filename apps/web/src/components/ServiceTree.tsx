'use client'

import Box from '@mui/material/Box'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useConsole } from '../store/console'
import { C, MONO } from '../lib/tokens'
import { HealthDot } from './indicators'

interface TreeService {
  name: string
  requests: number
  errors: number
  lastSeen: number | null
  health: 'ok' | 'warn' | 'bad' | 'idle'
}
interface TreeApp {
  name: string
  services: TreeService[]
  requests: number
  errors: number
  health: 'ok' | 'warn' | 'bad' | 'idle'
}
interface TreeEnv {
  name: string
  applications: TreeApp[]
}

function compact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

/** The tree is built from what has actually been received plus the keys that
 *  exist, so a service that has never sent still shows — as idle, not missing. */
export function ServiceTree() {
  const { treeExpanded, toggleTreeNode, filters, patchFilters } = useConsole()
  const { data, isError } = useQuery({
    queryKey: ['tree'],
    queryFn: async (): Promise<{ environments: TreeEnv[] }> => {
      const res = await fetch('/api/tree?range=24h')
      if (!res.ok) throw new Error('tree ' + res.status)
      return res.json()
    },
    refetchInterval: 30_000,
  })

  if (isError) {
    return (
      <Box sx={{ px: 3, py: 2, fontSize: 11, color: C.error }}>
        Could not load the application tree.
      </Box>
    )
  }

  const envs = data?.environments ?? []
  if (!envs.length) {
    return (
      <Box sx={{ px: 3, py: 2, fontSize: 11, color: C.muted, lineHeight: 1.6 }}>
        No applications yet. Create a key for a service and it appears here.
      </Box>
    )
  }

  const select = (application: string, service: string, environment: string) => {
    const already = filters.application === application && filters.service === service
    patchFilters({
      application: already ? '' : application,
      service: already ? '' : service,
      environment: already ? '' : environment,
    })
  }

  return (
    <Box sx={{ py: 1 }}>
      {envs.map((env) => {
        const envOpen = treeExpanded.includes(env.name)
        return (
          <Box key={env.name}>
            <Row
              depth={0}
              open={envOpen}
              onToggle={() => toggleTreeNode(env.name)}
              label={env.name}
              meta={env.applications.length + ' apps'}
            />
            {envOpen
              ? env.applications.map((app) => {
                  const id = env.name + '/' + app.name
                  const appOpen = treeExpanded.includes(id)
                  const active = filters.application === app.name
                  return (
                    <Box key={id}>
                      <Row
                        depth={1}
                        open={appOpen}
                        hasChildren={app.services.length > 1}
                        onToggle={() => toggleTreeNode(id)}
                        onSelect={() => select(app.name, app.services[0]?.name ?? app.name, env.name)}
                        label={app.name}
                        meta={compact(app.requests)}
                        health={app.health}
                        active={active}
                      />
                      {appOpen && app.services.length > 1
                        ? app.services.map((svc) => (
                            <Row
                              key={id + '/' + svc.name}
                              depth={2}
                              label={svc.name}
                              meta={compact(svc.requests)}
                              health={svc.health}
                              active={filters.service === svc.name}
                              onSelect={() => select(app.name, svc.name, env.name)}
                            />
                          ))
                        : null}
                    </Box>
                  )
                })
              : null}
          </Box>
        )
      })}
    </Box>
  )
}

function Row({
  depth,
  label,
  meta,
  open,
  hasChildren = true,
  health,
  active,
  onToggle,
  onSelect,
}: {
  depth: number
  label: string
  meta?: string
  open?: boolean
  hasChildren?: boolean
  health?: 'ok' | 'warn' | 'bad' | 'idle'
  active?: boolean
  onToggle?: () => void
  onSelect?: () => void
}) {
  const interactive = Boolean(onSelect || onToggle)
  return (
    <Box
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={() => (onSelect ? onSelect() : onToggle?.())}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect ? onSelect() : onToggle?.()
        }
      }}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        height: 24,
        pl: 2 + depth * 3,
        pr: 2,
        cursor: interactive ? 'pointer' : 'default',
        background: active ? C.selected : 'transparent',
        borderLeft: '2px solid ' + (active ? C.accent : 'transparent'),
        '&:hover': { background: active ? C.selected : C.raised },
      }}
    >
      {onToggle && hasChildren ? (
        <Box
          component="span"
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
          sx={{ display: 'flex', color: C.muted, '&:hover': { color: C.text } }}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </Box>
      ) : (
        <Box component="span" sx={{ width: 12, flex: 'none' }} />
      )}
      {health ? <HealthDot health={health} title={health === 'idle' ? 'No traffic yet' : health} /> : null}
      <Box
        component="span"
        sx={{
          fontSize: depth === 0 ? 11 : 12,
          fontWeight: depth === 0 ? 600 : 400,
          color: depth === 0 ? C.text2 : active ? C.text : C.text2,
          letterSpacing: depth === 0 ? '0.03em' : 0,
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontFamily: depth === 0 ? undefined : MONO,
        }}
      >
        {label}
      </Box>
      {meta ? (
        <Box component="span" sx={{ fontSize: 10, color: C.muted, fontFamily: MONO, flex: 'none' }}>
          {meta}
        </Box>
      ) : null}
    </Box>
  )
}
