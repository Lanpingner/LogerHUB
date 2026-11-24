const LOKI_URL = (process.env.LOKI_URL ?? 'http://localhost:3100').replace(/\/$/, '')

export interface SearchFilters {
  services: string[]
  envs: string[]
  levels: string[]
  /** Structured-metadata filters: company_id, user_id, api_key_id, status, … */
  dims: Record<string, string>
  /** Free text, matched against the whole JSON line. */
  text: string
  /** Treat `text` as a regular expression. */
  regex: boolean
  sinceHours: number
  limit: number
}

export const EMPTY_FILTERS: SearchFilters = {
  services: [],
  envs: [],
  levels: [],
  dims: {},
  text: '',
  regex: false,
  sinceHours: 1,
  limit: 200,
}

function quote(v: string): string {
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

function selector(values: string[]): string {
  // One value is an equality match; several become an anchored alternation.
  if (values.length === 1) return '=' + quote(values[0])
  return '=~' + quote('^(' + values.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$')
}

/** Compiles UI filters into LogQL. Labels go in the stream selector; everything
 *  else is a label filter on structured metadata, which is unindexed. */
export function toLogQL(f: SearchFilters): string {
  const parts: string[] = []
  if (f.services.length) parts.push('service' + selector(f.services))
  if (f.envs.length) parts.push('env' + selector(f.envs))
  if (f.levels.length) parts.push('level' + selector(f.levels))
  // Loki requires at least one matcher; match any known service as a floor.
  const stream = parts.length ? '{' + parts.join(', ') + '}' : '{service=~".+"}'

  let q = stream
  if (f.text) q += f.regex ? ' |~ ' + quote(f.text) : ' |= ' + quote(f.text)
  for (const [k, v] of Object.entries(f.dims)) {
    if (!v) continue
    q += ' | ' + k + ' = ' + quote(v)
  }
  return q
}

export interface LogLine {
  ts: number
  labels: Record<string, string>
  metadata: Record<string, string>
  line: string
  parsed: Record<string, unknown> | null
}

interface LokiStream {
  stream: Record<string, string>
  values: [string, string, Record<string, string>?][]
}

export async function search(f: SearchFilters): Promise<{ lines: LogLine[]; query: string; error?: string }> {
  const query = toLogQL(f)
  const end = Date.now() * 1e6
  const start = (Date.now() - f.sinceHours * 3600_000) * 1e6
  const url =
    LOKI_URL +
    '/loki/api/v1/query_range?query=' +
    encodeURIComponent(query) +
    '&start=' + start +
    '&end=' + end +
    '&limit=' + f.limit +
    '&direction=backward'

  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) {
      return { lines: [], query, error: 'Loki returned ' + res.status + ': ' + (await res.text().catch(() => '')).slice(0, 200) }
    }
    const body = (await res.json()) as { data?: { result?: LokiStream[] } }
    const lines: LogLine[] = []
    for (const s of body.data?.result ?? []) {
      for (const [ns, line, metadata] of s.values) {
        let parsed: Record<string, unknown> | null = null
        try {
          const p = JSON.parse(line)
          if (p && typeof p === 'object') parsed = p as Record<string, unknown>
        } catch {
          // A non-JSON line is still shown raw.
        }
        lines.push({ ts: Number(ns) / 1e6, labels: s.stream, metadata: metadata ?? {}, line, parsed })
      }
    }
    lines.sort((a, b) => b.ts - a.ts)
    return { lines, query }
  } catch (e) {
    return { lines: [], query, error: 'Could not reach Loki at ' + LOKI_URL + ': ' + (e as Error).message }
  }
}
