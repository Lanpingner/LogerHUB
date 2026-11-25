import type { LogEntry } from '@logguber/shared'
import { LOKI_LIMITS } from '@logguber/shared'

export interface LokiPushOptions {
  url: string
  /** Fields promoted from an entry's dims/meta into structured metadata. */
  metadataKeys: string[]
  /** The address the batch arrived from, as the gateway resolved it. Stamped on
   *  every entry: the sender cannot set it, and it is the only record of where a
   *  line actually came from once the connection is gone. */
  sourceIp?: string
}

/** Per entry kind, the `meta.<kind>` fields promoted into Loki's structured
 *  metadata. Promotion is what makes a field server-side filterable, so this
 *  table is the other half of `FIELDS` in the query language: `tool:` works
 *  because `tool` is here. `duration_ms` is deliberately the same name under
 *  both kinds — that is what lets `duration:>500` span them. */
const METADATA_FROM_META = {
  http: ['method', 'route', 'status', 'duration_ms', 'request_id'],
  mcp: ['tool', 'role', 'call_id', 'duration_ms', 'ok'],
} as const

function structuredMetadata(e: LogEntry, extra: string[], sourceIp?: string): Record<string, string> {
  const out: Record<string, string> = {}
  // First, so it survives the metadata ceilings below: a sender can push the
  // count over the limit with its own dims, and the gateway's own observation is
  // the one entry that must not be the casualty.
  if (sourceIp) out.source_ip = sourceIp
  for (const k of extra) {
    const v = e.dims?.[k]
    if (typeof v === 'string' && v) out[k] = v
  }
  if (e.kind) out.kind = e.kind
  for (const [section, keys] of Object.entries(METADATA_FROM_META)) {
    const from = (e.meta as Record<string, unknown> | undefined)?.[section]
    if (from === null || typeof from !== 'object') continue
    for (const k of keys) {
      const v = (from as Record<string, unknown>)[k]
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

function line(e: LogEntry, sourceIp?: string): string {
  const body: Record<string, unknown> = {}
  // The sender's payload is spread FIRST, then the validated fields are written
  // over it. The other order let a sender's `meta.msg` or `meta.dims` replace the
  // real ones, so the line a human reads disagreed with the usage counters — a
  // way to attribute an action to another company.
  if (e.meta) {
    for (const [k, v] of Object.entries(e.meta)) {
      // Keys we generate ourselves, such as truncation markers, cannot be forged.
      if (k.startsWith('_')) continue
      body[k] = v
    }
  }
  body.msg = e.msg
  // Underscored, so the loop above cannot carry a forged one: the sender's keys
  // beginning with `_` are dropped. In the line as well as in metadata because
  // Loki does not return structured metadata from query_range by default.
  if (sourceIp) body._source_ip = sourceIp
  // Dimensions go in the line as well as in structured metadata: Loki does not
  // return metadata in query_range values by default, so a reader would
  // otherwise see rows with no company or user.
  if (e.dims && Object.keys(e.dims).length) body.dims = e.dims
  if (e.kind) body.kind = e.kind
  let s = JSON.stringify(body)
  if (Buffer.byteLength(s) > LOKI_LIMITS.maxLineBytes) {
    s = JSON.stringify({
      msg: e.msg,
      _line_truncated: true,
      _bytes: Buffer.byteLength(s),
      ...(sourceIp ? { _source_ip: sourceIp } : {}),
    })
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
    s.values.push([ns, line(e, opts.sourceIp), structuredMetadata(e, opts.metadataKeys, opts.sourceIp)])
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
