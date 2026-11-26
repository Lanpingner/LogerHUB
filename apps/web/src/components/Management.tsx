'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import TextField from '@mui/material/TextField'
import { useState, useTransition } from 'react'
import Link from 'next/link'
import { KeyRound, Trash2 } from 'lucide-react'
import { C, MONO } from '../lib/tokens'
import { Panel } from './Panel'
import { HealthDot } from './indicators'
import { useConsole } from '../store/console'
import { nameClientAction, revokeKeyAction, saveAccessAction, saveHierarchyAction } from '../app/actions'
import { CreateKey } from './CreateKey'

export interface KeyView {
  id: string
  name: string
  key_id: string
  service_scope: string[]
  env_scope: string[] | null
  ip_allowlist: string[]
  disabled_at: number | null
  last_used_at: number | null
  last_used_ip: string | null
}

function ago(ms: number | null): string {
  if (!ms) return 'never'
  const d = Date.now() - ms
  if (d < 45_000) return 'moments ago'
  if (d < 3_600_000) return Math.round(d / 60_000) + 'm ago'
  if (d < 86_400_000) return Math.round(d / 3_600_000) + 'h ago'
  return Math.round(d / 86_400_000) + 'd ago'
}

export function ApiKeys({ keys, knownServices = [] }: { keys: KeyView[]; knownServices?: string[] }) {
  const [pending, start] = useTransition()
  const live = keys.filter((k) => !k.disabled_at).length

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Header title="API Keys" hint={live + ' active of ' + keys.length} />
      <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
        <Panel title="Ingestion credentials" hint="scoped per service and environment" flush minHeight={240}>
          <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse' }}>
            <Box component="thead">
              <Box component="tr">
                {['Name', 'Key', 'Services', 'Environments', 'Allowed from', 'Last used', ''].map((h) => (
                  <Box
                    component="th"
                    key={h}
                    sx={{
                      textAlign: 'left',
                      fontSize: 10.5,
                      fontWeight: 500,
                      color: C.text2,
                      px: 1.5,
                      py: 1,
                      background: C.raised,
                      borderBottom: '1px solid ' + C.border,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {h}
                  </Box>
                ))}
              </Box>
            </Box>
            <Box component="tbody">
              {keys.length === 0 ? (
                <Box component="tr">
                  <Box component="td" colSpan={7} sx={{ px: 1.5, py: 2, fontSize: 11.5, color: C.muted }}>
                    No keys yet. Nothing can send logs until one exists.
                  </Box>
                </Box>
              ) : (
                keys.map((k) => (
                  <Box component="tr" key={k.id} sx={{ opacity: k.disabled_at ? 0.45 : 1, '&:hover': { background: C.raised } }}>
                    <Td>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <HealthDot health={k.disabled_at ? 'bad' : k.last_used_at ? 'ok' : 'idle'} />
                        {k.name}
                      </Box>
                    </Td>
                    <Td color={C.muted}>{k.key_id}</Td>
                    <Td>{k.service_scope.join(', ') || '—'}</Td>
                    <Td>{k.env_scope?.join(', ') ?? 'any'}</Td>
                    <Td>{k.ip_allowlist.join(', ') || 'anywhere'}</Td>
                    <Td color={C.text2}>
                      {ago(k.last_used_at)}
                      {k.last_used_ip ? '  ' + k.last_used_ip : ''}
                    </Td>
                    <Td>
                      {k.disabled_at ? (
                        <Box component="span" sx={{ color: C.muted }}>
                          revoked
                        </Box>
                      ) : (
                        <Button
                          startIcon={<Trash2 size={11} />}
                          disabled={pending}
                          onClick={() => {
                            if (window.confirm('Revoke "' + k.name + '"? Its open connections close immediately.')) {
                              start(() => void revokeKeyAction(k.id))
                            }
                          }}
                          sx={{ color: C.error, borderColor: 'rgba(248,113,113,0.4)' }}
                        >
                          Revoke
                        </Button>
                      )}
                    </Td>
                  </Box>
                ))
              )}
            </Box>
          </Box>
        </Panel>

        <Panel title="Create a key" hint="the secret is shown once and never stored" minHeight={0}>
          <CreateKey knownServices={knownServices} />
        </Panel>
      </Box>
    </Box>
  )
}

export function Settings({
  levels,
  allowlist,
  names,
}: {
  levels: { key: string; label: string }[]
  allowlist: string[]
  names: Record<string, Record<string, string>>
}) {
  const [pending, start] = useTransition()
  const [hierarchy, setHierarchy] = useState(levels.map((l) => l.key + ': ' + l.label).join('\n'))
  const [allow, setAllow] = useState(allowlist.join(' '))
  const [dimKey, setDimKey] = useState(levels[1]?.key ?? 'company_id')
  const [dimValue, setDimValue] = useState('')
  const [display, setDisplay] = useState('')

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Header title="Settings" hint="Hierarchy and access" />
      <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 2, alignItems: 'start' }}>
          <Panel title="Usage hierarchy" hint="drives drill-down and filters" minHeight={0}>
            <TextField
              multiline
              minRows={4}
              fullWidth
              value={hierarchy}
              onChange={(e) => setHierarchy(e.target.value)}
              slotProps={{ input: { sx: { fontFamily: MONO, fontSize: 12, lineHeight: 1.7 } } }}
              helperText="One level per line, as key: Label"
            />
            <Button
              variant="contained"
              disabled={pending}
              onClick={() => start(() => void saveHierarchyAction(hierarchy))}
              sx={{ mt: 1.5 }}
            >
              Save hierarchy
            </Button>
            <Box sx={{ mt: 1.5, fontSize: 11, color: C.muted, lineHeight: 1.7 }}>
              Only <code>service</code> is a Loki label. Everything else is structured metadata, so adding a level
              needs no migration — and starts recording from the moment you save it.
            </Box>
          </Panel>

          <Panel title="Access" minHeight={0}>
            <TextField
              fullWidth
              label="Allowed source addresses (CIDR)"
              value={allow}
              onChange={(e) => setAllow(e.target.value)}
              placeholder="203.0.113.4/32 10.0.0.0/8"
              slotProps={{ input: { sx: { fontFamily: MONO, fontSize: 12 } }, inputLabel: { shrink: true } }}
              helperText="Empty accepts connections from anywhere. A key with its own list ignores this."
            />
            {/* This was an editable "keep raw logs for (days)" field that
                nothing read: retention is enforced by Loki, from
                deploy/loki.yaml, and the number here changed only itself. A
                control that does nothing is worse than no control, so it now
                states what is actually configured. */}
            <Box sx={{ mt: 2, fontSize: 11.5, color: C.text2, lineHeight: 1.9 }}>
              <Box sx={{ fontSize: 11, color: C.muted, mb: 0.5 }}>Retention, as Loki is configured</Box>
              <Box>debug and info — 14 days</Box>
              <Box>warn and anything else — 30 days</Box>
              <Box>error and fatal — 90 days</Box>
              <Box sx={{ fontSize: 11, color: C.muted, mt: 1 }}>
                Set in <Box component="span" sx={{ fontFamily: MONO }}>deploy/loki.yaml</Box> and applied by Loki's
                compactor, so changing it is a deploy rather than a setting. Usage counters are never pruned.
              </Box>
            </Box>
            <Button
              variant="contained"
              disabled={pending}
              onClick={() => start(() => void saveAccessAction(allow))}
              sx={{ mt: 1.5, display: 'block' }}
            >
              Save settings
            </Button>
          </Panel>

          <Panel title="Client names" hint="cosmetic; never sent in a log" minHeight={0}>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <Select value={dimKey} onChange={(e) => setDimKey(e.target.value)} sx={{ height: 28, fontSize: 12, minWidth: 120 }}>
                {levels.map((l) => (
                  <MenuItem key={l.key} value={l.key}>
                    {l.key}
                  </MenuItem>
                ))}
              </Select>
              <TextField
                placeholder="acme"
                value={dimValue}
                onChange={(e) => setDimValue(e.target.value)}
                slotProps={{ input: { sx: { fontFamily: MONO, fontSize: 12 } } }}
                sx={{ width: 130 }}
              />
              <TextField
                placeholder="Acme Ltd"
                value={display}
                onChange={(e) => setDisplay(e.target.value)}
                sx={{ width: 160 }}
              />
              <Button
                disabled={pending || !dimValue || !display}
                onClick={() =>
                  start(async () => {
                    await nameClientAction(dimKey, dimValue, display)
                    setDimValue('')
                    setDisplay('')
                  })
                }
              >
                Add name
              </Button>
            </Box>
            <Box sx={{ mt: 2, display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              {Object.entries(names).flatMap(([k, vals]) =>
                Object.entries(vals).map(([v, d]) => (
                  <Box
                    key={k + v}
                    sx={{
                      fontSize: 11,
                      fontFamily: MONO,
                      border: '1px solid ' + C.border,
                      borderRadius: '3px',
                      px: 1,
                      py: 0.25,
                      color: C.text2,
                    }}
                  >
                    {v} → {d}
                  </Box>
                )),
              )}
              {Object.keys(names).length === 0 ? (
                <Box sx={{ fontSize: 11, color: C.muted }}>Nothing named yet, so charts show raw ids.</Box>
              ) : null}
            </Box>
          </Panel>
        </Box>
      </Box>
    </Box>
  )
}

export function SavedQueries() {
  const { savedQueries, queryHistory, removeSavedQuery, patchFilters } = useConsole()
  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Header title="Saved Queries" hint={savedQueries.length + ' saved, ' + queryHistory.length + ' recent'} />
      <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 2, alignItems: 'start' }}>
          <Panel title="Saved" minHeight={160}>
            {savedQueries.length === 0 ? (
              <Box sx={{ fontSize: 11.5, color: C.muted }}>
                Nothing saved yet. Press the star in the query bar on the Live Console or Log Explorer.
              </Box>
            ) : (
              savedQueries.map((q) => (
                <Box
                  key={q.name}
                  sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 0.75, borderBottom: '1px solid ' + C.border }}
                >
                  <Box sx={{ fontSize: 12, color: C.text, minWidth: 110 }}>{q.name}</Box>
                  <Box
                    component={Link}
                    href="/explorer"
                    onClick={() => patchFilters({ query: q.query })}
                    sx={{ fontFamily: MONO, fontSize: 11, color: C.accent, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}
                  >
                    {q.query}
                  </Box>
                  <Button onClick={() => removeSavedQuery(q.name)} sx={{ color: C.error, borderColor: 'rgba(248,113,113,0.4)' }}>
                    Remove
                  </Button>
                </Box>
              ))
            )}
          </Panel>
          <Panel title="Recent" minHeight={160}>
            {queryHistory.length === 0 ? (
              <Box sx={{ fontSize: 11.5, color: C.muted }}>No queries run yet in this browser.</Box>
            ) : (
              queryHistory.map((q, i) => (
                <Box
                  key={q + i}
                  component={Link}
                  href="/explorer"
                  onClick={() => patchFilters({ query: q })}
                  sx={{
                    display: 'block',
                    fontFamily: MONO,
                    fontSize: 11,
                    color: C.text2,
                    py: 0.5,
                    borderBottom: '1px solid ' + C.border,
                    '&:hover': { color: C.text },
                  }}
                >
                  {q}
                </Box>
              ))
            )}
          </Panel>
        </Box>
      </Box>
    </Box>
  )
}

function Td({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <Box
      component="td"
      sx={{
        px: 1.5,
        py: 0.75,
        fontFamily: MONO,
        fontSize: 11,
        color: color ?? C.text,
        borderBottom: '1px solid ' + C.border,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </Box>
  )
}

function Header({ title, hint }: { title: string; hint: string }) {
  return (
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
      <Box sx={{ fontSize: 13, fontWeight: 600 }}>{title}</Box>
      <Box sx={{ fontSize: 11, color: C.muted }}>{hint}</Box>
    </Box>
  )
}
