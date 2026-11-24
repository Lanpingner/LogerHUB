import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * API key minting and checking. It lives here, rather than in the gateway, because
 * the console mints keys too: two copies of this would be two chances for the hash
 * format to drift, and a drifted format means a key the console issues that the
 * gateway refuses — or worse, accepts for the wrong reason.
 *
 * Deliberately NOT exported from this package's index, so it stays out of the
 * published client bundle: a logging client has no business carrying the code that
 * issues credentials.
 *
 * The secret is hashed with a plain SHA-256 and no salt, which is right here and
 * would be wrong for a password: the secret is 24 random bytes from the CSPRNG, so
 * there is no dictionary to attack and nothing for a salt to defend against. The
 * comparison is constant-time regardless.
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

export function secretMatches(secret: string, expectedHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), 'hex')
  let b: Buffer
  try {
    b = Buffer.from(expectedHash, 'hex')
  } catch {
    return false
  }
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface MintedKey {
  /** The only time the full key exists: it is never stored and cannot be shown again. */
  full: string
  keyId: string
  secret: string
  hash: string
}

export function mintKey(): MintedKey {
  const keyId = randomBytes(6).toString('hex')
  const secret = randomBytes(24).toString('base64url')
  return { full: `lgb_${keyId}_${secret}`, keyId, secret, hash: hashSecret(secret) }
}
