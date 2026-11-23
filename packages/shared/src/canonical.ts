/**
 * Canonical JSON for a dimension set: only the configured levels, keys sorted,
 * each level exactly once. Anything that is not a non-blank string-like value
 * becomes "unknown". Safe for untrusted input and for any level name.
 */
export function canonicalDims(dims: Record<string, string | undefined>, levels: string[]): string {
  const out: Record<string, string> = Object.create(null)
  for (const level of [...new Set(levels)].sort()) {
    const value: unknown = Object.hasOwn(dims, level) ? dims[level] : undefined
    out[level] = normalise(value)
  }
  return JSON.stringify(out)
}

function normalise(value: unknown): string {
  if (value === undefined || value === null) return 'unknown'
  if (typeof value === 'object' || typeof value === 'function' || typeof value === 'symbol') return 'unknown'
  const s = String(value)
  return s.trim() === '' ? 'unknown' : s
}
