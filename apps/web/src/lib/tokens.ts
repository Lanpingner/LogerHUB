/** LogerHub design tokens, straight from the specification.
 *  Green is the operational accent — active selection, live connection,
 *  success — not a colour applied to every border. Most borders are graphite. */
export const C = {
  bg: '#080C10',
  sidebar: '#0B1016',
  panel: '#0D131A',
  raised: '#131B24',
  border: '#25313D',
  selected: '#142D20',
  text: '#DCE4ED',
  text2: '#8492A3',
  muted: '#526171',
  accent: '#4ADE80',
  success: '#4ADE80',
  warning: '#FBBF24',
  error: '#F87171',
  info: '#38BDF8',
  purple: '#C084FC',
} as const

export const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
export const SANS = "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif"

/** HTTP method colours, per the specification. */
export const METHOD_COLOR: Record<string, string> = {
  GET: C.info,
  POST: C.accent,
  PUT: C.warning,
  PATCH: C.purple,
  DELETE: C.error,
  OPTIONS: C.muted,
  HEAD: '#60A5FA',
}

/** HTTP status class colours, per the specification. */
export function statusColor(status: number): string {
  if (status >= 500) return C.error
  if (status >= 400) return C.warning
  if (status >= 300) return '#60A5FA'
  if (status >= 200) return C.accent
  return C.muted
}

export function levelColor(level: string): string {
  switch (level) {
    case 'fatal':
    case 'error':
      return C.error
    case 'warn':
      return C.warning
    case 'debug':
      return C.muted
    default:
      return C.text2
  }
}

/** Latency thresholds: amber then red, so a slow request is visible in a scan. */
export function latencyColor(ms: number): string {
  if (ms >= 1000) return C.error
  if (ms >= 300) return C.warning
  return C.text2
}

export const TIME_RANGES = [
  { key: '5m', label: 'Last 5 minutes', minutes: 5 },
  { key: '15m', label: 'Last 15 minutes', minutes: 15 },
  { key: '1h', label: 'Last hour', minutes: 60 },
  { key: '6h', label: 'Last 6 hours', minutes: 360 },
  { key: '24h', label: 'Last 24 hours', minutes: 1440 },
  { key: '7d', label: 'Last 7 days', minutes: 10080 },
  { key: '30d', label: 'Last 30 days', minutes: 43200 },
] as const

export type TimeRangeKey = (typeof TIME_RANGES)[number]['key']

export function minutesFor(key: string): number {
  return TIME_RANGES.find((r) => r.key === key)?.minutes ?? 60
}
