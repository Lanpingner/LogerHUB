import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * Operator password hashing, shared because three places need it and the format
 * must match exactly: the seed CLI writes it, the gateway writes it when it
 * bootstraps the first account, and the console writes it on a password change.
 * A fourth copy would be a fourth chance to lock everyone out.
 *
 * Deliberately NOT exported from this package's index, so it stays out of the
 * published client bundle.
 *
 * Cost is above Node's default (N=16384) and recorded in the hash, so it can be
 * raised later without invalidating accounts created before the change.
 */
export const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }

/** The shortest password accepted anywhere. Enforced by every writer. */
export const MIN_PASSWORD_LENGTH = 12

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64, SCRYPT).toString('hex')
  return 'scrypt$' + SCRYPT.N + ':' + SCRYPT.r + ':' + SCRYPT.p + '$' + salt + '$' + hash
}

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
