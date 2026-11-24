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

/**
 * Who the session says you are. It does NOT consider whether the account still
 * has its bootstrap password, so it answers "is this a valid session" and nothing
 * more. Pages and the root layout use it: the layout is what replaces the console
 * with the change-password screen, and a page that redirected instead would bounce
 * a flagged operator to a login form they are already past.
 *
 * Anything that ACTS — a server action, an API route — must use
 * `activeOperator()` instead.
 */
export async function currentOperator(): Promise<{ email: string } | null> {
  const jar = await cookies()
  return readSession(jar.get(COOKIE)?.value)
}

/**
 * A session whose account is fully set up. Null while the account still has the
 * password it was created with, so a flagged operator can read nothing and change
 * nothing but their own password.
 *
 * The layout's gate only governs what is rendered. Server actions and API routes
 * are separately addressable endpoints that never go through it, so without this
 * a `admin`/`admin` login could mint an API key or read every log by POSTing
 * directly — which would defeat the point of forcing the change at all.
 */
export async function activeOperator(): Promise<{ email: string } | null> {
  const session = await currentOperator()
  if (!session) return null
  const row = operatorByEmail(session.email)
  // No row means the account was deleted under a live session: fail closed.
  if (!row || row.must_change_password === 1) return null
  return { email: session.email }
}

export type Gate =
  | { state: 'anonymous' }
  | { state: 'must-change'; email: string }
  | { state: 'active'; email: string }

/**
 * What the root layout should render. One function rather than an expression in
 * the layout, because the safe default is not the obvious one:
 * `operatorByEmail()` returns undefined both for a deleted account and for a
 * read it could not perform, and `undefined?.must_change_password === 1` is
 * false — so written inline, a transient database error would open the console
 * to an account that has not set a password yet.
 *
 * Anything it cannot positively confirm is `must-change`: a screen that asks for
 * a password it cannot verify is a dead end, which is the right failure.
 */
export async function operatorGate(): Promise<Gate> {
  const session = await currentOperator()
  if (!session) return { state: 'anonymous' }
  const row = operatorByEmail(session.email)
  if (!row) return { state: 'must-change', email: session.email }
  if (row.must_change_password === 1) return { state: 'must-change', email: session.email }
  return { state: 'active', email: session.email }
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
    // A Secure cookie is only sent back over HTTPS, which is right for the
    // normal deployment behind a TLS proxy. It is also a trap for anyone
    // reaching the console over plain HTTP on a domain or IP: the browser keeps
    // the cookie on localhost (a secure context) but drops it anywhere else, so
    // pages load and then an action fails with no session. COOKIE_INSECURE=1 is
    // the deliberate opt-out, and it means the cookie travels in clear text.
    secure: process.env.COOKIE_INSECURE === '1' ? false : process.env.NODE_ENV === 'production',
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
