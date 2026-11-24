import { scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * Written by the gateway's seed CLI, in one of two shapes:
 *   `scrypt$<salt>$<hash>`              — original, Node's default cost
 *   `scrypt$<N>:<r>:<p>$<salt>$<hash>`  — current, cost recorded so it can be raised
 *
 * Both are accepted so raising the cost does not lock out operators created
 * before the change.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts[0] !== 'scrypt') return false

  let salt: string
  let hash: string
  let params: { N: number; r: number; p: number; maxmem: number } | undefined

  if (parts.length === 3) {
    ;[, salt, hash] = parts
  } else if (parts.length === 4) {
    const [n, r, p] = parts[1].split(':').map(Number)
    if (![n, r, p].every((v) => Number.isInteger(v) && v > 0)) return false
    params = { N: n, r, p, maxmem: 256 * 1024 * 1024 }
    salt = parts[2]
    hash = parts[3]
  } else {
    return false
  }

  let expected: Buffer
  try {
    expected = Buffer.from(hash, 'hex')
  } catch {
    return false
  }
  if (!expected.length) return false

  let actual: Buffer
  try {
    actual = params
      ? (scryptSync(password, salt, expected.length, params) as Buffer)
      : (scryptSync(password, salt, expected.length) as Buffer)
  } catch {
    return false
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
