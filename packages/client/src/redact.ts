import type { RedactOptions } from './types'

export const DEFAULT_HEADER_ALLOWLIST: string[] = [
  'host', 'user-agent', 'content-type', 'content-length', 'accept', 'referer', 'x-request-id',
]

export const DEFAULT_REDACT_KEYS: string[] = [
  'password', 'pass', 'token', 'secret', 'apikey', 'api_key', 'authorization',
  'credential', 'card', 'cardnumber', 'cvv', 'ssn', 'otp', 'refresh_token',
  'passwd', 'pwd', 'jwt', 'bearer', 'cookie', 'sessionid',
]

/** Keys containing any of these (after normalisation) are redacted. Deliberately no bare "key". */
const SECRET_SUBSTRINGS = ['password', 'secret', 'token', 'credential', 'apikey', 'privatekey']

const normaliseKey = (k: string): string => k.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '')

const REDACTED = '[redacted]'
const CIRCULAR = '[circular]'
const UNREDACTABLE = '[unredactable]'

export function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/** Keeps only allowlisted headers, lower-cased. Anything not named is dropped. */
export function redactHeaders(
  headers: unknown,
  allowlist: string[] = DEFAULT_HEADER_ALLOWLIST,
): Record<string, string> {
  if (headers === null || typeof headers !== 'object') return {}
  try {
    const allowed = new Set(allowlist.map((h) => h.toLowerCase()))
    const out: Record<string, string> = {}
    for (const [name, value] of Object.entries(headers)) {
      const key = name.toLowerCase()
      if (!allowed.has(key)) continue
      let text: string
      if (typeof value === 'string') text = value
      else if (typeof value === 'number') text = String(value)
      else if (Array.isArray(value)) text = value.map(String).join(', ')
      else continue
      if (key === 'referer') {
        const safe = scrubUrl(text)
        if (safe === undefined) continue
        text = safe
      }
      out[key] = text
    }
    return out
  } catch {
    return {}   // fail closed: capture nothing rather than throw into the request path
  }
}

/** Scheme, host and path only: query, fragment and userinfo can carry tokens. Undefined if unparseable. */
function scrubUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return undefined
  }
}

/** Parses a string that looks like a JSON object/array; `undefined` when it is not one. */
function parseJsonContainer(s: string): unknown {
  const t = s.trim()
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined
  try {
    return JSON.parse(t)
  } catch {
    return undefined
  }
}

/**
 * Replaces the value of every secret-bearing key, at any depth, with `[redacted]`.
 * Keys are normalised (lower-cased, non-alphanumerics stripped), then matched exactly against
 * the default and custom lists, or by containing a secret substring such as `token`.
 * With `allowFields`, only those top-level fields survive (and are still redacted).
 */
export function redactBody(value: unknown, opts: RedactOptions = {}): unknown {
  try {
    return redactBodyUnsafe(value, opts)
  } catch {
    return UNREDACTABLE   // fail closed: never return the raw value, never throw
  }
}

function redactBodyUnsafe(value: unknown, opts: RedactOptions): unknown {
  // Custom keys extend the defaults; narrowing is what allowFields is for.
  const exact = new Set([...DEFAULT_REDACT_KEYS, ...(opts.redactKeys ?? [])].map(normaliseKey))
  const isSecret = (key: string): boolean => {
    const n = normaliseKey(key)
    return n !== '' && (exact.has(n) || SECRET_SUBSTRINGS.some((s) => n.includes(s)))
  }
  const allow = opts.allowFields ? new Set(opts.allowFields) : undefined
  const ancestors = new Set<object>()

  const walk = (v: unknown, top: boolean): unknown => {
    if (typeof v === 'string') {
      const parsed = parseJsonContainer(v)
      return parsed === undefined ? v : walk(parsed, false)
    }
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
        entries.push([k, isSecret(k) ? REDACTED : walk(child, false)])
      }
      return Object.fromEntries(entries)   // own-property semantics, so a "__proto__" key stays data
    } finally {
      ancestors.delete(v)
    }
  }

  if (typeof value === 'string') {
    const parsed = parseJsonContainer(value)
    if (parsed !== undefined) value = parsed
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
  if (value === undefined) return undefined
  const json = safeStringify(value)
  const bytes = byteLength(json)
  // Round-trip so the result is always plain-JSON serialisable (no cycles, BigInt, functions).
  return bytes <= maxBytes ? JSON.parse(json) : { _truncated: true, _bytes: bytes }
}
