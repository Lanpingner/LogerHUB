'use client'

import Box from '@mui/material/Box'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import Tooltip from '@mui/material/Tooltip'
import IconButton from '@mui/material/IconButton'
import dynamic from 'next/dynamic'
import { memo, useMemo, useState } from 'react'
import { Check, Copy, X } from 'lucide-react'
import type { LogRow } from '../lib/types'
import { C, MONO, latencyColor, statusColor } from '../lib/tokens'
import { HttpMethodIndicator, LatencyIndicator, StatusCodeIndicator } from './indicators'

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
  loading: () => <Box sx={{ p: 2, fontSize: 11, color: C.muted }}>Loading editor…</Box>,
})

/** Tabs per entry kind. An MCP call has no headers and no response body, and a
 *  pane that is permanently empty is worse than no pane: it reads as missing
 *  data rather than as a question that does not apply. */
const HTTP_TABS = ['Overview', 'Request', 'Response', 'Headers', 'Timing', 'Trace', 'Exception', 'Raw JSON'] as const
const MCP_TABS = ['Overview', 'Arguments', 'Result', 'Timing', 'Error', 'Raw JSON'] as const
type TabName = (typeof HTTP_TABS)[number] | (typeof MCP_TABS)[number]

function section(row: LogRow, name: 'http' | 'mcp'): Record<string, unknown> {
  const h = row.payload?.[name]
  return h && typeof h === 'object' ? (h as Record<string, unknown>) : {}
}

const http = (row: LogRow): Record<string, unknown> => section(row, 'http')
const mcp = (row: LogRow): Record<string, unknown> => section(row, 'mcp')

const isMcp = (row: LogRow): boolean => row.kind === 'mcp'

/** `TOOL` for a call this service served, `CALL` for one it made. The same two
 *  words the client prints in its own terminal. */
function McpRoleIndicator({ role }: { role?: string }) {
  const text = role === 'client' ? 'CALL' : 'TOOL'
  return (
    <Box component="span" sx={{ fontFamily: MONO, fontSize: 11, fontWeight: 600, color: C.purple }}>
      {text}
    </Box>
  )
}

function OutcomeIndicator({ ok }: { ok?: boolean }) {
  if (ok == null) return null
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

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false)
  return (
    <Tooltip title={done ? 'Copied' : label}>
      <IconButton
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setDone(true)
            setTimeout(() => setDone(false), 1200)
          })
        }}
        aria-label={label}
      >
        {done ? <Check size={12} color={C.accent} /> : <Copy size={12} />}
      </IconButton>
    </Tooltip>
  )
}

function Json({ value }: { value: unknown }) {
  const text = useMemo(() => JSON.stringify(value, null, 2), [value])
  return (
    <Box sx={{ position: 'relative', height: '100%' }}>
      <Box sx={{ position: 'absolute', top: 4, right: 12, zIndex: 2 }}>
        <CopyButton text={text} label="Copy payload" />
      </Box>
      <MonacoEditor
        height="100%"
        language="json"
        theme="vs-dark"
        value={text}
        options={{
          readOnly: true,
          minimap: { enabled: false },
          fontSize: 11.5,
          fontFamily: "'JetBrains Mono', monospace",
          lineNumbers: 'on',
          folding: true,
          scrollBeyondLastLine: false,
          renderLineHighlight: 'none',
          overviewRulerLanes: 0,
          scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
          padding: { top: 8, bottom: 8 },
          wordWrap: 'on',
        }}
      />
    </Box>
  )
}

function Field({ label, children, mono = true }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: '112px minmax(0, 1fr)', gap: 2, py: 0.75, alignItems: 'baseline' }}>
      <Box sx={{ fontSize: 11, color: C.muted }}>{label}</Box>
      <Box sx={{ fontSize: 11.5, fontFamily: mono ? MONO : undefined, color: C.text, overflowWrap: 'anywhere' }}>
        {children ?? <Box component="span" sx={{ color: C.muted }}>—</Box>}
      </Box>
    </Box>
  )
}

/** Only timings that were actually collected are shown — an empty waterfall is
 *  better than invented segments. */
function Timing({ row }: { row: LogRow }) {
  // Phases are reported the same way for both kinds — logger.time() — so this
  // renderer is shared; only where the map lives differs.
  const h = isMcp(row) ? mcp(row) : http(row)
  const timings = (h.timings ?? h.timing) as Record<string, number> | undefined
  const total = row.duration ?? 0
  // Scalars, deliberately not merged into `timings`: that map is drawn as one flat
  // waterfall normalised by its sum, and phases like db run inside server time, so
  // mixing them would double-count. Absent on entries logged before the split existed.
  const split = (
    <>
      {typeof h.server_ms === 'number' ? (
        <Field label="Server">
          <LatencyIndicator ms={h.server_ms} />
        </Field>
      ) : null}
      {typeof h.transit_ms === 'number' ? (
        <Field label="Transit">
          <LatencyIndicator ms={h.transit_ms} />
        </Field>
      ) : null}
    </>
  )

  if (!timings || typeof timings !== 'object' || !Object.keys(timings).length) {
    return (
      <Box sx={{ p: 3 }}>
        <Field label="Total">{row.duration != null ? <LatencyIndicator ms={row.duration} /> : null}</Field>
        {split}
        <Box sx={{ mt: 2, fontSize: 11.5, color: C.muted, lineHeight: 1.7 }}>
          No phase breakdown was reported for this {isMcp(row) ? 'call' : 'request'}. Wrap the work you want to
          see, for example{' '}
          <Box component="code" sx={{ fontFamily: MONO, color: C.text2 }}>
            {"logger.time('db', fn)"}
          </Box>
          , and it appears here as a phase.
        </Box>
      </Box>
    )
  }

  const entries = Object.entries(timings).filter(([, v]) => typeof v === 'number' && v >= 0)
  const sum = entries.reduce((a, [, v]) => a + v, 0) || 1
  let offset = 0
  // Phases run inside server time, so that is what they are measured against; transit
  // is response delivery and can never be attributed to a phase. Entries without the
  // split fall back to total.
  const ref = typeof h.server_ms === 'number' ? h.server_ms : total
  const basis = typeof h.server_ms === 'number' ? 'server time' : 'total'
  let note: string | null = null
  if (ref && sum - ref > ref * 0.05) {
    // Concurrent phases each report their full duration, so overlap is expected, not an error.
    note = `Phases sum to ${Math.round(sum)}ms, more than the ${Math.round(ref)}ms of ${basis}. Phases that run concurrently each report their full duration, so they can overlap.`
  } else if (ref && ref - sum > ref * 0.05) {
    note =
      basis === 'server time'
        ? `Phases cover ${Math.round(sum)}ms of ${Math.round(ref)}ms server time; the remaining ${Math.round(ref - sum)}ms is server time that no phase accounts for.`
        : `Phases sum to ${Math.round(sum)}ms against a total of ${Math.round(ref)}ms; the difference is time not attributed to any phase.`
  }
  const palette = [C.info, C.accent, C.purple, C.warning, '#60A5FA', C.error]

  return (
    <Box sx={{ p: 3 }}>
      <Field label="Total">{row.duration != null ? <LatencyIndicator ms={row.duration} /> : null}</Field>
      {split}
      <Box sx={{ mt: 2, display: 'grid', gap: 1 }}>
        {entries.map(([name, value], i) => {
          const width = (value / sum) * 100
          const left = (offset / sum) * 100
          offset += value
          return (
            <Box key={name} sx={{ display: 'grid', gridTemplateColumns: '116px 1fr 64px', gap: 2, alignItems: 'center' }}>
              <Box sx={{ fontSize: 11, color: C.text2 }}>{name}</Box>
              <Box sx={{ position: 'relative', height: 14, background: C.bg, borderRadius: '2px' }}>
                <Box
                  sx={{
                    position: 'absolute',
                    left: left + '%',
                    width: Math.max(0.8, width) + '%',
                    top: 0,
                    bottom: 0,
                    background: palette[i % palette.length],
                    borderRadius: '2px',
                  }}
                />
              </Box>
              <Box sx={{ fontFamily: MONO, fontSize: 11, color: C.text2, textAlign: 'right' }}>
                {Math.round(value)}ms
              </Box>
            </Box>
          )
        })}
      </Box>
      {note ? (
        <Box sx={{ mt: 2, fontSize: 11, color: C.muted }}>{note}</Box>
      ) : null}
    </Box>
  )
}

/* Memoised: in the live view this sits beside the stream, so without it every
 * arriving batch of log lines re-rendered the whole inspector — tabs, headers
 * table, waterfall and the Monaco editor — measured at 4.75ms a render and
 * paid only once a row had been clicked. Both call sites pass a stable
 * `onClose`; an inline arrow there would quietly undo this. */
export const RequestInspector = memo(function RequestInspector({
  row,
  onClose,
}: {
  row: LogRow
  onClose: () => void
}) {
  const [tab, setTab] = useState<TabName>('Overview')
  const h = http(row)
  const m = mcp(row)
  const tool = isMcp(row)
  const TABS: readonly TabName[] = tool ? MCP_TABS : HTTP_TABS
  // Clicking a second row can change the kind under a selected tab, and the tab
  // that was open may not exist in the new set.
  const active: TabName = TABS.includes(tab) ? tab : 'Overview'
  const req = (h.req ?? {}) as Record<string, unknown>
  const res = (h.res ?? {}) as Record<string, unknown>
  const err = (row.payload?.err ?? row.payload?.error ?? row.payload?.exception) as
    | Record<string, unknown>
    | undefined
  // A failed tool call's error is recorded by the client as name and message.
  const mcpErr = (m.error ?? undefined) as Record<string, unknown> | undefined

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', background: C.panel, minWidth: 0 }}>
      <Box
        sx={{
          height: 34,
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          px: 2,
          borderBottom: '1px solid ' + C.border,
        }}
      >
        {tool ? <McpRoleIndicator role={row.mcpRole} /> : <HttpMethodIndicator method={row.method} />}
        <Box
          sx={{
            fontFamily: MONO,
            fontSize: 11.5,
            color: C.text,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={(tool ? row.tool : row.path) ?? row.msg}
        >
          {(tool ? row.tool : row.path) ?? row.msg}
        </Box>
        {tool ? <OutcomeIndicator ok={row.ok} /> : <StatusCodeIndicator status={row.status} />}
        <CopyButton text={JSON.stringify(row.payload ?? { msg: row.msg }, null, 2)} label="Copy payload" />
        <Tooltip title="Close · Esc">
          <IconButton onClick={onClose} aria-label="Close inspector">
            <X size={13} />
          </IconButton>
        </Tooltip>
      </Box>

      <Tabs
        value={active}
        onChange={(_e, v) => setTab(v as TabName)}
        variant="scrollable"
        scrollButtons={false}
        sx={{ flex: 'none', px: 1 }}
      >
        {TABS.map((t) => (
          <Tab key={t} value={t} label={t} />
        ))}
      </Tabs>

      <Box sx={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {active === 'Overview' ? (
          <Box sx={{ p: 3 }}>
            <Field label="Time">{new Date(row.ts).toISOString().replace('T', ' ').replace('Z', '')}</Field>
            <Field label="Level">
              <Box component="span" sx={{ color: statusColor(row.status ?? 200) }}>
                {row.level}
              </Box>
            </Field>
            <Field label="Message" mono={false}>
              {row.msg}
            </Field>
            <Field label="Application">{row.application}</Field>
            <Field label="Service">{row.service}</Field>
            <Field label="Environment">{row.env}</Field>
            <Field label="Instance">{row.instance}</Field>
            <Field label="Source IP">{row.sourceIp}</Field>
            <Box sx={{ height: 1, background: C.border, my: 1.5 }} />
            {tool ? (
              <>
                <Field label="Tool">{row.tool}</Field>
                <Field label="Role">{row.mcpRole === 'client' ? 'client — a tool this service used' : 'server — a call this service served'}</Field>
                <Field label="MCP server">{row.mcpServer}</Field>
                <Field label="Outcome">
                  <OutcomeIndicator ok={row.ok} />
                </Field>
              </>
            ) : (
              <>
                <Field label="Method">{row.method}</Field>
                <Field label="Route">{row.route}</Field>
                <Field label="Status">{row.status}</Field>
              </>
            )}
            <Field label="Duration">
              {row.duration != null ? (
                <Box component="span" sx={{ color: latencyColor(row.duration) }}>
                  {Math.round(row.duration)}ms
                </Box>
              ) : null}
            </Field>
            <Box sx={{ height: 1, background: C.border, my: 1.5 }} />
            <Field label="Company">{row.company}</Field>
            <Field label="User">{row.user}</Field>
            <Field label="API key">{row.apiKey}</Field>
            {tool ? <Field label="Call id">{row.callId}</Field> : <Field label="Request id">{row.requestId}</Field>}
            <Field label="Trace id">{row.traceId}</Field>
          </Box>
        ) : null}

        {active === 'Request' ? (
          Object.keys(req).length ? (
            <Json value={req} />
          ) : (
            <Empty what="request body or query" hint="Body capture defaults to errors only. Change it per service in the SDK options." />
          )
        ) : null}

        {active === 'Response' ? (
          Object.keys(res).length ? (
            <Json value={res} />
          ) : (
            <Empty what="response body" hint="Response bodies are captured only for JSON responses, and only when the policy asks for them." />
          )
        ) : null}

        {active === 'Headers' ? (
          req.headers && typeof req.headers === 'object' && Object.keys(req.headers).length ? (
            <Box sx={{ p: 3 }}>
              {Object.entries(req.headers as Record<string, unknown>).map(([k, v]) => (
                <Field key={k} label={k}>
                  {String(v)}
                </Field>
              ))}
              <Box sx={{ mt: 2, fontSize: 11, color: C.muted, lineHeight: 1.7 }}>
                Headers are captured by allowlist, so anything carrying credentials — authorization, cookie,
                x-api-key — never leaves your service.
              </Box>
            </Box>
          ) : (
            <Empty what="headers" hint="Only allowlisted headers are captured, and this request carried none of them." />
          )
        ) : null}

        {active === 'Timing' ? <Timing row={row} /> : null}

        {active === 'Trace' ? (
          row.traceId ? (
            <Box sx={{ p: 3 }}>
              <Field label="Trace id">{row.traceId}</Field>
              <Box sx={{ mt: 2, fontSize: 11.5, color: C.muted, lineHeight: 1.7 }}>
                Searching related spans needs a trace index; for now, query{' '}
                <Box component="code" sx={{ fontFamily: MONO, color: C.text2 }}>
                  trace:{row.traceId}
                </Box>{' '}
                in the Log Explorer to see every line sharing this trace.
              </Box>
            </Box>
          ) : (
            <Empty what="trace" hint="This request carried no trace id. Send one as meta.http.trace_id to correlate across services." />
          )
        ) : null}

        {active === 'Exception' ? (
          err ? (
            <Box sx={{ p: 3 }}>
              <Field label="Type">
                <Box component="span" sx={{ color: C.error }}>
                  {String(err.name ?? err.type ?? 'Error')}
                </Box>
              </Field>
              <Field label="Message" mono={false}>
                {String(err.message ?? '')}
              </Field>
              {err.stack ? (
                <Box
                  component="pre"
                  sx={{
                    mt: 2,
                    fontFamily: MONO,
                    fontSize: 11,
                    color: C.text2,
                    background: C.bg,
                    border: '1px solid ' + C.border,
                    borderRadius: '4px',
                    p: 2,
                    overflow: 'auto',
                    lineHeight: 1.6,
                  }}
                >
                  {String(err.stack)}
                </Box>
              ) : null}
            </Box>
          ) : (
            <Empty what="exception" hint="No error object was attached to this line." />
          )
        ) : null}

        {active === 'Arguments' ? (
          m.args !== undefined ? (
            <Json value={m.args} />
          ) : (
            <Empty
              what="arguments"
              subject="call"
              hint="Arguments are captured by default; `capture: 'never'` or 'on-error' in the SDK options turns them off for a successful call."
            />
          )
        ) : null}

        {active === 'Result' ? (
          m.result !== undefined ? (
            <Json value={m.result} />
          ) : (
            <Empty
              what="result"
              subject="call"
              hint="A call that threw has no result — see the Error tab. Otherwise capture was off for this call."
            />
          )
        ) : null}

        {active === 'Error' ? (
          mcpErr ? (
            <Box sx={{ p: 3 }}>
              <Field label="Type">
                <Box component="span" sx={{ color: C.error }}>
                  {String(mcpErr.name ?? 'Error')}
                </Box>
              </Field>
              <Field label="Message" mono={false}>
                {String(mcpErr.message ?? '')}
              </Field>
              <Box sx={{ mt: 2, fontSize: 11, color: C.muted, lineHeight: 1.7, maxWidth: 420 }}>
                A tool error is recorded as its name and message; the stack stays inside the service that threw
                it. A call that failed without throwing — a result carrying `isError` — shows under Result.
              </Box>
            </Box>
          ) : (
            <Empty
              what="error"
              subject="call"
              hint={row.ok === false
                ? 'This call failed without throwing: the tool returned a result flagged isError, which is under Result.'
                : 'This call succeeded.'}
            />
          )
        ) : null}

        {active === 'Raw JSON' ? <Json value={row.payload ?? { msg: row.msg }} /> : null}
      </Box>
    </Box>
  )
})

function Empty({ what, hint, subject = 'request' }: { what: string; hint: string; subject?: string }) {
  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ fontSize: 12, color: C.text2 }}>No {what} was recorded for this {subject}.</Box>
      <Box sx={{ mt: 1, fontSize: 11, color: C.muted, lineHeight: 1.7, maxWidth: 420 }}>{hint}</Box>
    </Box>
  )
}
