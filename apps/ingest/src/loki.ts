import type { LogEntry } from '@logguber/shared'
import { LOKI_LIMITS } from '@logguber/shared'

export interface LokiPushOptions {
  url: string
  /** Fields promoted from an entry's dims/meta into structured metadata. */
  metadataKeys: string[]
}

const METADATA_FROM_META = ['method', 'route', 'status', 'duration_ms', 'request_id'] as const

function structuredMetadata(e: LogEntry, extra: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of extra) {
    const v = e.dims?.[k]
    if (typeof v === 'string' && v) out[k] = v
  }
  if (e.kind) out.kind = e.kind
  const http = (e.meta as { http?: Record<string, unknown> } | undefined)?.http
  if (http && typeof http === 'object') {
    for (const k of METADATA_FROM_META) {
      const v = (http as Record<string, unknown>)[k]
      if (v != null && typeof v !== 'object') out[k] = String(v)
    }
  }
  // Respect Loki's ceilings rather than letting the distributor reject the batch.
  const keys = Object.keys(out)
  if (keys.length > LOKI_LIMITS.maxMetadataEntries) {
    for (const k of keys.slice(LOKI_LIMITS.maxMetadataEntries)) delete out[k]
  }
  let bytes = 0
  for (const [k, v] of Object.entries(out)) {
    bytes += Buffer.byteLength(k) + Buffer.byteLength(v)
    if (bytes > LOKI_LIMITS.maxMetadataBytes) delete out[k]
  }
  return out
}

function line(e: LogEntry): string {
  const body: Record<string, unknown> = { msg: e.msg }
  // Dimensions go in the line as well as in structured metadata: Loki does not
  // return metadata in query_range values by default, so a reader would
  // otherwise see rows with no company or user.
  if (e.dims && Object.keys(e.dims).length) body.dims = e.dims
  if (e.kind) body.kind = e.kind
  if (e.meta) for (const [k, v] of Object.entries(e.meta)) body[k] = v
  let s = JSON.stringify(body)
  if (Buffer.byteLength(s) > LOKI_LIMITS.maxLineBytes) {
    s = JSON.stringify({ msg: e.msg, _line_truncated: true, _bytes: Buffer.byteLength(s) })
  }
  return s
}

/** Groups entries into streams by the three indexed labels, then pushes. */
export async function pushToLoki(
  entries: LogEntry[],
  service: string,
  env: string,
  opts: LokiPushOptions,
): Promise<void> {
  const streams = new Map<string, { stream: Record<string, string>; values: unknown[][] }>()
  for (const e of entries) {
    const labels = { service, env, level: e.level }
    const key = `${service}\u0000${env}\u0000${e.level}`
    let s = streams.get(key)
    if (!s) {
      s = { stream: labels, values: [] }
      streams.set(key, s)
    }
    const ns = String(BigInt(Date.parse(e.ts) || Date.now()) * 1000000n)
    s.values.push([ns, line(e), structuredMetadata(e, opts.metadataKeys)])
  }

  const res = await fetch(`${opts.url.replace(/\/$/, '')}/loki/api/v1/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ streams: [...streams.values()] }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`loki push ${res.status}: ${text.slice(0, 300)}`)
  }
}
