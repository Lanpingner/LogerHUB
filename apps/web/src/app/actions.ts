'use server'

import { revalidatePath } from 'next/cache'
import { randomUUID } from 'node:crypto'
import { mintKey } from '@logguber/shared/keys'
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from '@logguber/shared/password'
import { cookies } from 'next/headers'
import { activeOperator, currentOperator, logout, readSession, SESSION_COOKIE } from '../lib/auth'
import {
  disableKey,
  insertKey,
  operatorByEmail,
  putLabel,
  saveSettings,
  setOperatorPassword,
  settings,
} from '../lib/store'

const INGEST_URL = (process.env.INGEST_INTERNAL_URL ?? 'http://localhost:8080').replace(/\/$/, '')
const CONSOLE_SECRET = process.env.CONSOLE_SECRET ?? ''

/** Server actions are independently addressable POST endpoints: a page's own
 *  auth check does not protect them, so every action re-verifies the session. */
async function requireOperator() {
  // `activeOperator`, not `currentOperator`: an account that still has its
  // bootstrap password must not be able to mint a key or change settings by
  // POSTing straight to an action, bypassing the layout's gate entirely.
  const operator = await activeOperator()
  if (!operator) throw new Error('unauthorised')
  return operator
}

/**
 * Logs an unexpected failure in full and returns a short reference for it.
 *
 * The message itself never goes to the caller. Server actions are addressable
 * endpoints, so an unauthenticated POST that makes something throw would
 * otherwise be handed whatever the exception says — a SQLite error naming the
 * database path, a module path, a stack frame. The reference is what ties the
 * screen in front of a person to the line in `docker compose logs web`, which
 * is the part that was actually worth having.
 */
function reportFailure(where: string, e: unknown): string {
  const ref = Math.random().toString(16).slice(2, 8)
  console.error(`[${ref}] ${where} failed`, e)
  return ref
}

/** For the two things a not-yet-set-up account is allowed to do. */
async function requireSession() {
  const operator = await currentOperator()
  if (!operator) throw new Error('unauthorised')
  return operator
}

/** A revoked key must also lose its open sockets, not merely fail its next handshake. */
async function notifyGateway(): Promise<void> {
  if (!CONSOLE_SECRET) return
  try {
    await fetch(INGEST_URL + '/internal/reload', {
      method: 'POST',
      headers: { 'x-console-secret': CONSOLE_SECRET },
      cache: 'no-store',
    })
  } catch {
    // The gateway also polls the config version, so a missed call costs seconds.
  }
}

export async function revokeKeyAction(id: string): Promise<void> {
  await requireOperator()
  disableKey(id)
  await notifyGateway()
  revalidatePath('/keys')
}

export async function saveHierarchyAction(text: string): Promise<void> {
  await requireOperator()
  const levels = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [key, ...rest] = line.split(/[:,]/)
      return { key: key.trim(), label: rest.join(':').trim() || key.trim() }
    })
    .filter((l) => l.key)
  if (!levels.length) return
  const current = settings()
  saveSettings({ levels, globalIpAllowlist: current.globalIpAllowlist })
  await notifyGateway()
  revalidatePath('/settings')
}

export async function saveAccessAction(allowlistText: string): Promise<void> {
  await requireOperator()
  const current = settings()
  const allowlist = allowlistText
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  saveSettings({ levels: current.levels, globalIpAllowlist: allowlist })
  await notifyGateway()
  revalidatePath('/settings')
}

export async function nameClientAction(dimKey: string, value: string, display: string): Promise<void> {
  await requireOperator()
  if (dimKey && value && display) putLabel(dimKey, value, display)
  revalidatePath('/settings')
}

export async function signOutAction(): Promise<void> {
  await logout()
}

/**
 * The current password is required even when the account is being forced to
 * change it: a session cookie alone must not be enough to take an account over,
 * or a stolen cookie becomes permanent access.
 */
export async function changePasswordAction(
  current: string,
  next: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Everything is inside the catch deliberately. A server action that throws
  // reaches the browser as a minified React error with the message stripped,
  // which tells the one person who could fix it nothing at all — and this is
  // the screen standing between a new install and its console.
  try {
    // Checked by hand rather than through requireSession, because the two ways
    // this fails need different answers and a bare "unauthorised" gives neither.
    const jar = await cookies()
    const token = jar.get(SESSION_COOKIE)?.value
    if (!token) {
      return {
        ok: false,
        error:
          'Your browser did not send the login cookie with this request. If you reach the console over plain ' +
          'HTTP on a domain or IP, that cookie is marked Secure and the browser will not send it: use HTTPS, ' +
          'or set COOKIE_INSECURE=1 in .env and restart. Otherwise your session expired — sign in again.',
      }
    }
    const session = readSession(token)
    if (!session) {
      return {
        ok: false,
        error: 'Your session is no longer valid — it expired, or SESSION_SECRET changed since you signed in. Sign in again.',
      }
    }
    const operator = session
    const row = operatorByEmail(operator.email)
    if (!row) {
      return {
        ok: false,
        error:
          'Your account could not be read. If the console was just updated, the database may be mid-migration: ' +
          'restart the gateway (docker compose restart ingest) and reload.',
      }
    }
    if (!verifyPassword(current, row.password_hash)) return { ok: false, error: 'The current password is wrong.' }
    if (next.length < MIN_PASSWORD_LENGTH) {
      return { ok: false, error: `Use at least ${MIN_PASSWORD_LENGTH} characters.` }
    }
    if (next === current) return { ok: false, error: 'That is the password you already have.' }
    // The one value that must never survive this screen.
    if (next.toLowerCase() === 'admin') return { ok: false, error: 'Pick something other than the default.' }
    if (!setOperatorPassword(operator.email, hashPassword(next))) {
      return { ok: false, error: 'The new password could not be saved. The console may not be able to write to the database.' }
    }
    // No revalidatePath here: it would swap the layout out from under the form
    // while the transition that called this is still running. The client calls
    // router.refresh() once it has the result, which is ordered and visible.
    return { ok: true }
  } catch (e) {
    const ref = reportFailure('changePasswordAction', e)
    return {
      ok: false,
      error: `The server could not change the password (ref ${ref}). The reason is in: docker compose logs web | grep ${ref}`,
    }
  }
}

const KEY_NAME = /^[\w .-]{1,64}$/
/** Matches the gateway's own check, so a key the console issues cannot be unusable. */
const SCOPE_ITEM = /^[a-z0-9][a-z0-9_-]{0,63}$/i

function scopeList(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).map((v) => v.trim()).filter(Boolean))]
}

/**
 * Mints a key and returns the secret ONCE. It is never stored and cannot be shown
 * again — only its hash is kept, so a leaked database does not hand over the keys
 * themselves.
 */
export async function createKeyAction(
  name: string,
  servicesRaw: string,
  envsRaw: string,
  allowlistRaw: string,
): Promise<{ ok: true; secret: string; keyId: string } | { ok: false; error: string }> {
  await requireOperator()
  const trimmed = name.trim()
  if (!KEY_NAME.test(trimmed)) return { ok: false, error: 'Give the key a name: letters, digits, dot, dash, space.' }

  const services = scopeList(servicesRaw)
  if (services.length === 0) return { ok: false, error: 'Name at least one service the key may write.' }
  if (!services.every((v) => SCOPE_ITEM.test(v))) return { ok: false, error: 'Service names must be alphanumeric.' }

  const envs = scopeList(envsRaw)
  // Required, not optional: a key with no environment scope may write any
  // environment name it likes, and each distinct name becomes a Loki stream.
  if (envs.length === 0) return { ok: false, error: 'Name at least one environment, such as prod.' }
  if (!envs.every((v) => SCOPE_ITEM.test(v))) return { ok: false, error: 'Environment names must be alphanumeric.' }

  const allowlist = scopeList(allowlistRaw)
  if (!allowlist.every((v) => /^[0-9a-f.:]+(\/\d{1,3})?$/i.test(v))) {
    return { ok: false, error: 'Allowed-from entries must be IP addresses or CIDR ranges.' }
  }

  const minted = mintKey()
  try {
    insertKey({
      id: randomUUID(),
      name: trimmed,
      key_id: minted.keyId,
      secret_hash: minted.hash,
      service_scope: services,
      env_scope: envs,
      ip_allowlist: allowlist,
    })
  } catch (e) {
    const ref = reportFailure('createKeyAction', e)
    return {
      ok: false,
      error: `The key could not be saved (ref ${ref}). The reason is in: docker compose logs web | grep ${ref}`,
    }
  }
  await notifyGateway()
  revalidatePath('/keys')
  return { ok: true, secret: minted.full, keyId: minted.keyId }
}
