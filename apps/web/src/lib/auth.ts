import { createHmac, timingSafeEqual } from 'node:crypto'
// Kept in its own module: it is pure crypto, so it stays importable outside the
// Next runtime (the seeding and verification scripts check it directly).
import { verifyPassword } from './password'
import { cookies } from 'next/headers'
import { operatorByEmail } from './store'

const SECRET = process.env.SESSION_SECRET ?? ''
const COOKIE = 'logguber_session'
const MAX_AGE_SECONDS = 60 * 60 * 12

function sign(payload: string): string {
  return createHmac('sha256', SECRET).update(payload).digest('base64url')
}

export function issueSession(email: string): string {
  const expires = Date.now() + MAX_AGE_SECONDS * 1000
  const payload = Buffer.from(JSON.stringify({ email, expires })).toString('base64url')
  return payload + '.' + sign(payload)
}

export function readSession(token: string | undefined): { email: string } | null {
  if (!token || !SECRET) return null
  const dot = token.lastIndexOf('.')
  if (dot === -1) return null
  const payload = token.slice(0, dot)
  const mac = token.slice(dot + 1)
  const expected = sign(payload)
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null
  try {
    const { email, expires } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      email: string
      expires: number
    }
    if (!email || typeof expires !== 'number' || Date.now() > expires) return null
    return { email }
  } catch {
    return null
  }
}

export async function currentOperator(): Promise<{ email: string } | null> {
  const jar = await cookies()
  return readSession(jar.get(COOKIE)?.value)
}

export async function login(email: string, password: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!SECRET) return { ok: false, error: 'SESSION_SECRET is not set on the server.' }
  const operator = operatorByEmail(email)
  // Always run the hash comparison so a missing account and a wrong password cost the same time.
  const stored = operator?.password_hash ?? 'scrypt$0000$' + '0'.repeat(128)
  const ok = verifyPassword(password, stored)
  if (!operator || !ok) return { ok: false, error: 'Wrong email or password.' }
  const jar = await cookies()
  jar.set(COOKIE, issueSession(email), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  })
  return { ok: true }
}

export async function logout(): Promise<void> {
  const jar = await cookies()
  jar.delete(COOKIE)
}

export const SESSION_COOKIE = COOKIE

export { verifyPassword }
