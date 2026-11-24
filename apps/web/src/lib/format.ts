export function count(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M'
  if (n >= 10_000) return (n / 1_000).toFixed(n >= 100_000 ? 0 : 1) + 'K'
  return n.toLocaleString()
}

export function bytes(n: number): string {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB'
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB'
  if (n >= 1024) return Math.round(n / 1024) + ' KB'
  return n + ' B'
}

export function percent(part: number, whole: number, digits = 1): string {
  if (!whole) return '—'
  return ((part / whole) * 100).toFixed(digits) + '%'
}

export function clock(ms: number): string {
  const d = new Date(ms)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3)
}

export function stamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return p(d.getDate()) + '/' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

export function ago(ms: number | null): string {
  if (!ms) return 'never'
  const diff = Date.now() - ms
  if (diff < 45_000) return 'moments ago'
  if (diff < 3_600_000) return Math.round(diff / 60_000) + ' min ago'
  if (diff < 86_400_000) return Math.round(diff / 3_600_000) + ' hours ago'
  return Math.round(diff / 86_400_000) + ' days ago'
}

export function rangeLabel(hours: number): string {
  if (hours <= 1) return 'the last hour'
  if (hours < 24) return 'the last ' + hours + ' hours'
  if (hours === 24) return 'the last day'
  return 'the last ' + Math.round(hours / 24) + ' days'
}

/** Series colours in fixed slot order — never cycled, never generated. */
export const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)'] as const

export function serviceColor(service: string, all: string[]): string {
  const i = all.indexOf(service)
  // Past the four slots, the tail shares the last colour rather than inventing a hue.
  return SERIES[Math.min(i < 0 ? SERIES.length - 1 : i, SERIES.length - 1)]
}
