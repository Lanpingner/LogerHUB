import { createHash, timingSafeEqual, randomBytes } from 'node:crypto'

/** `lgb_<key_id>_<secret>` */
export function parseKey(header: string | undefined): { keyId: string; secret: string } | null {
  if (!header) return null
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  const raw = m ? m[1] : header.trim()
  // Split on the first two underscores only: the secret is base64url, which
  // includes '_', so splitting on every underscore rejects valid keys.
  const parts = /^lgb_([^_]+)_(.+)$/.exec(raw)
  if (!parts) return null
  return { keyId: parts[1], secret: parts[2] }
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

export function secretMatches(secret: string, expectedHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), 'hex')
  let b: Buffer
  try { b = Buffer.from(expectedHash, 'hex') } catch { return false }
  return a.length === b.length && timingSafeEqual(a, b)
}

export function mintKey(): { full: string; keyId: string; secret: string; hash: string } {
  const keyId = randomBytes(6).toString('hex')
  const secret = randomBytes(24).toString('base64url')
  return { full: `lgb_${keyId}_${secret}`, keyId, secret, hash: hashSecret(secret) }
}

function ipToBytes(ip: string): Uint8Array | null {
  const clean = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  if (clean.includes('.')) {
    const p = clean.split('.')
    if (p.length !== 4) return null
    const out = new Uint8Array(4)
    for (let i = 0; i < 4; i++) {
      const n = Number(p[i])
      if (!Number.isInteger(n) || n < 0 || n > 255) return null
      out[i] = n
    }
    return out
  }
  // IPv6
  const halves = clean.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = 8 - head.length - tail.length
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail]
  if (groups.length !== 8) return null
  const out = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    const n = parseInt(groups[i] || '0', 16)
    if (Number.isNaN(n) || n < 0 || n > 0xffff) return null
    out[i * 2] = n >> 8
    out[i * 2 + 1] = n & 0xff
  }
  return out
}

/** CIDR match in application code — SQLite has no network types. */
export function ipMatches(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf('/')
  const base = slash === -1 ? cidr : cidr.slice(0, slash)
  const a = ipToBytes(ip)
  const b = ipToBytes(base)
  if (!a || !b || a.length !== b.length) return false
  const bits = slash === -1 ? a.length * 8 : Number(cidr.slice(slash + 1))
  if (!Number.isInteger(bits) || bits < 0 || bits > a.length * 8) return false
  const full = bits >> 3
  for (let i = 0; i < full; i++) if (a[i] !== b[i]) return false
  const rem = bits & 7
  if (rem === 0) return true
  const mask = 0xff << (8 - rem)
  return (a[full] & mask) === (b[full] & mask)
}

export function ipAllowed(ip: string, keyList: string[], globalList: string[]): boolean {
  const list = keyList.length ? keyList : globalList
  if (!list.length) return true // no allowlist configured anywhere = open
  return list.some((c) => ipMatches(ip, c))
}

/** Socket address resolved through a configured number of trusted proxy hops. */
export function clientIp(socketIp: string, xff: string | undefined, hops: number): string {
  if (hops <= 0 || !xff) return socketIp
  const chain = xff.split(',').map((s) => s.trim()).filter(Boolean)
  // Take the hop-th address from the right: the nearest one we still trust.
  const idx = chain.length - hops
  return idx >= 0 && chain[idx] ? chain[idx] : socketIp
}
