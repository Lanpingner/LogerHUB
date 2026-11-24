import type { LogEntry } from '@logguber/shared'
import { canonicalDims } from '@logguber/shared'

export interface RollupRow {
  hour: number
  depth: number
  dims: string
  lines: number
  bytes: number
  requests: number
  errors: number
}

const HOUR = 3600

/** One row per *prefix* of the configured hierarchy, so each drill-down level reads
 *  pre-aggregated rows instead of summing across its children. */
export function rollupRows(
  entries: LogEntry[],
  service: string,
  levels: string[],
): RollupRow[] {
  const acc = new Map<string, RollupRow>()

  for (const e of entries) {
    const hour = Math.floor((Date.parse(e.ts) || Date.now()) / 1000 / HOUR) * HOUR
    const bytes = Buffer.byteLength(e.msg) + (e.meta ? Buffer.byteLength(JSON.stringify(e.meta)) : 0)
    const isRequest = e.kind === 'request' ? 1 : 0
    const isError = e.level === 'error' || e.level === 'fatal' ? 1 : 0
    const source: Record<string, string> = { ...(e.dims ?? {}), service }

    for (let depth = 1; depth <= levels.length; depth++) {
      const prefix = levels.slice(0, depth)
      const dims = canonicalDims(source, prefix)
      const key = `${hour}\u0000${depth}\u0000${dims}`
      let row = acc.get(key)
      if (!row) {
        row = { hour, depth, dims, lines: 0, bytes: 0, requests: 0, errors: 0 }
        acc.set(key, row)
      }
      row.lines += 1
      row.bytes += bytes
      row.requests += isRequest
      row.errors += isError
    }
  }

  return [...acc.values()]
}
