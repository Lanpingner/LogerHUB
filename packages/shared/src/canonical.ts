/**
 * Canonical JSON for a dimension set: only the configured levels, keys sorted,
 * missing or empty values filled with "unknown".
 */
export function canonicalDims(dims: Record<string, string | undefined>, levels: string[]): string {
  const out: Record<string, string> = {}
  for (const level of [...levels].sort()) {
    const value = dims[level]
    out[level] = value === undefined || value === '' ? 'unknown' : value
  }
  return JSON.stringify(out)
}
