import type { RedactOptions } from './types'

export const DEFAULT_HEADER_ALLOWLIST: string[] = [
  'host', 'user-agent', 'content-type', 'content-length', 'accept', 'referer', 'x-request-id',
]

export const DEFAULT_REDACT_KEYS: string[] = [
  'password', 'pass', 'token', 'secret', 'apikey', 'api_key', 'authorization',
  'credential', 'card', 'cardnumber', 'cvv', 'ssn', 'otp', 'refresh_token',
]

const REDACTED = '[redacted]'
const CIRCULAR = '[circular]'

export function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/** Keeps only allowlisted headers, lower-cased. Anything not named is dropped. */
export function redactHeaders(
  headers: unknown,
  allowlist: string[] = DEFAULT_HEADER_ALLOWLIST,
): Record<string, string> {
  if (headers === null || typeof headers !== 'object') return {}
  const allowed = new Set(allowlist.map((h) => h.toLowerCase()))
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase()
    if (!allowed.has(key)) continue
    if (typeof value === 'string') out[key] = value
    else if (typeof value === 'number') out[key] = String(value)
    else if (Array.isArray(value)) out[key] = value.map(String).join(', ')
  }
  return out
}

/**
 * Replaces the value of every secret-bearing key, at any depth, with `[redacted]`.
 * With `allowFields`, only those top-level fields survive (and are still redacted).
 */
export function redactBody(value: unknown, opts: RedactOptions = {}): unknown {
  const secret = new Set((opts.redactKeys ?? DEFAULT_REDACT_KEYS).map((k) => k.toLowerCase()))
  const allow = opts.allowFields ? new Set(opts.allowFields) : undefined
  const ancestors = new Set<object>()

  const walk = (v: unknown, top: boolean): unknown => {
    if (v === null || typeof v !== 'object') return v
    if (ancestors.has(v)) return CIRCULAR
    ancestors.add(v)
    try {
      let node: object = v
      const toJSON = (v as { toJSON?: unknown }).toJSON
      if (typeof toJSON === 'function') {
        const json: unknown = toJSON.call(v)
        if (json === null || typeof json !== 'object') return json
        node = json
      }
      if (Array.isArray(node)) return node.map((item) => walk(item, top))
      const entries: [string, unknown][] = []
      for (const [k, child] of Object.entries(node)) {
        if (top && allow && !allow.has(k)) continue
        entries.push([k, secret.has(k.toLowerCase()) ? REDACTED : walk(child, false)])
      }
      return Object.fromEntries(entries)   // own-property semantics, so a "__proto__" key stays data
    } finally {
      ancestors.delete(v)
    }
  }

  // Fail closed: in allowFields mode a bare primitive has no named field to keep.
  if (allow && (value === null || typeof value !== 'object')) return undefined
  return walk(value, true)
}

/** JSON.stringify that never throws: cycles, BigInt, functions, symbols and Errors all degrade. */
export function safeStringify(value: unknown): string {
  try {
    const stack: object[] = []
    const out = JSON.stringify(value, function (this: unknown, _key: string, v: unknown) {
      if (typeof v === 'bigint') return v.toString()
      if (typeof v === 'function' || typeof v === 'symbol') return undefined
      if (v === null || typeof v !== 'object') return v
      // `this` is the holder; unwind to it so only true ancestors count as cycles.
      while (stack.length > 0 && stack[stack.length - 1] !== this) stack.pop()
      if (stack.includes(v)) return CIRCULAR
      stack.push(v)
      if (v instanceof Error) return { name: v.name, message: v.message }
      return v
    })
    return out ?? 'null'
  } catch {
    return '"[unserialisable]"'
  }
}

/** Returns `value` when it serialises within `maxBytes`, else a small valid-JSON marker. */
export function truncateJson(value: unknown, maxBytes = 8192): unknown {
  const bytes = byteLength(safeStringify(value))
  return bytes <= maxBytes ? value : { _truncated: true, _bytes: bytes }
}
