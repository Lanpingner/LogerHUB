'use client'

import Box from '@mui/material/Box'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import { useState } from 'react'
import { C, MONO } from '../lib/tokens'
import { Panel } from './Panel'
import { HealthDot } from './indicators'
import type { KeyView } from './Management'

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
interface Problem {
  at: number
  key_id: string | null
  reason: string
  detail: string | null
}

const SNIPPETS = {
  'Node.js / Express': `import { createLogger } from '@logguber/client'

const log = createLogger({
  url: process.env.LOGGUBER_URL,      // wss://logs.example.com/v1/stream
  apiKey: process.env.LOGGUBER_KEY,
  service: 'APP',
  env: process.env.NODE_ENV,
  spool: { dir: '/var/lib/logguber' },
})

app.use(log.expressMiddleware({
  resolveDims: (req) => ({
    company_id: req.auth?.companyId,
    user_id: req.auth?.userId,
    api_key_id: req.auth?.keyId,
  }),
  ignore: (req) => req.path === '/health',
}))

process.on('SIGTERM', () => log.close())`,
  'Generic HTTP': `curl -X POST https://logs.example.com/v1/logs \\
  -H 'authorization: Bearer $LOGGUBER_KEY' \\
  -H 'content-type: application/json' \\
  --data '{
    "batch_id": "01JD8Z...",
    "service": "APP",
    "env": "production",
    "entries": [{
      "ts": "2026-11-24T09:51:02.124Z",
      "level": "info",
      "kind": "request",
      "msg": "GET /v1/users 200",
      "dims": { "company_id": "acme", "user_id": "u_1" },
      "meta": { "http": { "method": "GET", "route": "/v1/users", "status": 200, "duration_ms": 42 } }
    }]
  }'`,
  Python: `# No official SDK yet. The HTTP fallback above is the supported path:
# POST /v1/logs with a Bearer key, a batch_id for deduplication, and
# entries carrying dims for per-client usage counting.
#
# What an SDK must do to match the Node client:
#   batch on size or time, retry 5xx with backoff, never block the request,
#   redact headers by allowlist and secret-looking body keys before sending,
#   and spool to local storage while the gateway is unreachable.`,
} as const

export function Applications({
  environments,
  keys,
  problems,
}: {
  environments: TreeEnv[]
  keys: KeyView[]
  problems: Problem[]
}) {
  const [tab, setTab] = useState<keyof typeof SNIPPETS>('Node.js / Express')
  const apps = environments.flatMap((e) => e.applications.map((a) => ({ ...a, env: e.name })))

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Box
        sx={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          px: 2,
          py: 1,
          borderBottom: '1px solid ' + C.border,
          background: C.panel,
        }}
      >
        <Box sx={{ fontSize: 13, fontWeight: 600 }}>Applications</Box>
        <Box sx={{ fontSize: 11, color: C.muted }}>{apps.length} registered across {environments.length} environments</Box>
      </Box>

      <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 2, alignItems: 'start' }}>
          <Panel title="Registry" hint="last 24 hours" span={2} flush minHeight={200}>
            <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse' }}>
              <Box component="thead">
                <Box component="tr">
                  {['Application', 'Environment', 'Requests', 'Errors', 'Error rate', 'Last log', 'Key'].map((h, i) => (
                    <Box
                      component="th"
                      key={h}
                      sx={{
                        textAlign: i >= 2 && i <= 4 ? 'right' : 'left',
                        fontSize: 10.5,
                        fontWeight: 500,
                        color: C.text2,
                        px: 1.5,
                        py: 1,
                        background: C.raised,
                        borderBottom: '1px solid ' + C.border,
                      }}
                    >
                      {h}
                    </Box>
                  ))}
                </Box>
              </Box>
              <Box component="tbody">
                {apps.length === 0 ? (
                  <Box component="tr">
                    <Box component="td" colSpan={7} sx={{ px: 1.5, py: 2, fontSize: 11.5, color: C.muted }}>
                      No applications yet. Create a key and point a service at the gateway.
                    </Box>
                  </Box>
                ) : (
                  apps.map((a) => {
                    const key = keys.find((k) => k.service_scope.includes(a.name))
                    return (
                      <Box component="tr" key={a.env + a.name} sx={{ '&:hover': { background: C.raised } }}>
                        <Cell>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                            <HealthDot health={a.health} title={a.health === 'idle' ? 'No traffic yet' : a.health} />
                            {a.name}
                          </Box>
                        </Cell>
                        <Cell color={C.text2}>{a.env}</Cell>
                        <Cell right>{a.requests.toLocaleString()}</Cell>
                        <Cell right color={a.errors ? C.error : C.text2}>
                          {a.errors.toLocaleString()}
                        </Cell>
                        <Cell right color={a.requests && a.errors / a.requests > 0.02 ? C.error : C.text2}>
                          {a.requests ? ((a.errors / a.requests) * 100).toFixed(1) + '%' : '—'}
                        </Cell>
                        <Cell color={C.text2}>
                          {a.services[0]?.lastSeen
                            ? new Date(a.services[0].lastSeen).toLocaleTimeString(undefined, { hour12: false })
                            : 'never'}
                        </Cell>
                        <Cell color={C.muted}>{key?.key_id ?? 'none'}</Cell>
                      </Box>
                    )
                  })
                )}
              </Box>
            </Box>
          </Panel>

          <Panel title="Integration" hint="replace APP with the service name" span={2} minHeight={280}>
            <Tabs value={tab} onChange={(_e, v) => setTab(v as keyof typeof SNIPPETS)} sx={{ mb: 1.5 }}>
              {Object.keys(SNIPPETS).map((k) => (
                <Tab key={k} value={k} label={k} />
              ))}
            </Tabs>
            <Box
              component="pre"
              sx={{
                m: 0,
                p: 1.5,
                background: C.bg,
                border: '1px solid ' + C.border,
                borderRadius: '4px',
                fontFamily: MONO,
                fontSize: 11,
                lineHeight: 1.65,
                color: C.text,
                overflowX: 'auto',
              }}
            >
              {SNIPPETS[tab]}
            </Box>
          </Panel>

          <Panel title="Ingestion problems" hint={problems.length ? 'most recent first' : 'nothing recorded'} flush minHeight={180}>
            {problems.length === 0 ? (
              <Box sx={{ p: 2, fontSize: 11.5, color: C.muted }}>
                No refused addresses, malformed batches or client-reported loss.
              </Box>
            ) : (
              problems.slice(0, 40).map((p, i) => (
                <Box
                  key={i}
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: '92px 96px 1fr',
                    gap: 1.5,
                    px: 2,
                    py: 0.75,
                    borderBottom: '1px solid ' + C.border,
                    fontFamily: MONO,
                    fontSize: 10.5,
                  }}
                >
                  <Box sx={{ color: C.muted }}>
                    {new Date(p.at).toLocaleTimeString(undefined, { hour12: false })}
                  </Box>
                  <Box sx={{ color: C.warning }}>{p.reason.replace(/_/g, ' ')}</Box>
                  <Box sx={{ color: C.text2, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.detail ?? ''}</Box>
                </Box>
              ))
            )}
          </Panel>

          <Panel title="Retention and credentials" minHeight={180}>
            <Box sx={{ fontSize: 11.5, color: C.text2, lineHeight: 1.8 }}>
              Retention and the global address allowlist are in Settings. Keys are created from the gateway CLI so a
              secret never passes through a browser, and revoking one closes its live connections rather than only
              refusing the next handshake.
              <Box sx={{ mt: 1.5, color: C.muted }}>
                Per-application retention and owner or tag metadata need a schema change, so they arrive with the
                Postgres migration.
              </Box>
            </Box>
          </Panel>
        </Box>
      </Box>
    </Box>
  )
}

function Cell({ children, right, color }: { children: React.ReactNode; right?: boolean; color?: string }) {
  return (
    <Box
      component="td"
      sx={{
        px: 1.5,
        py: 0.75,
        fontFamily: MONO,
        fontSize: 11,
        color: color ?? C.text,
        textAlign: right ? 'right' : 'left',
        borderBottom: '1px solid ' + C.border,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </Box>
  )
}
