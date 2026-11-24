'use server'

import { revalidatePath } from 'next/cache'
import { randomUUID } from 'node:crypto'
import { mintKey } from '@logguber/shared/keys'
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from '@logguber/shared/password'
import { activeOperator, currentOperator, logout } from '../lib/auth'
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
  saveSettings({ levels, globalIpAllowlist: current.globalIpAllowlist, retentionDays: current.retentionDays })
  await notifyGateway()
  revalidatePath('/settings')
}

export async function saveAccessAction(allowlistText: string, retentionDays: number): Promise<void> {
  await requireOperator()
  const current = settings()
  const allowlist = allowlistText
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  saveSettings({
    levels: current.levels,
    globalIpAllowlist: allowlist,
    retentionDays: Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : current.retentionDays,
  })
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
  const operator = await requireSession()
  const row = operatorByEmail(operator.email)
  if (!row) return { ok: false, error: 'That account no longer exists.' }
  if (!verifyPassword(current, row.password_hash)) return { ok: false, error: 'The current password is wrong.' }
  if (next.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Use at least ${MIN_PASSWORD_LENGTH} characters.` }
  }
  if (next === current) return { ok: false, error: 'That is the password you already have.' }
  // The one value that must never survive this screen.
  if (next.toLowerCase() === 'admin') return { ok: false, error: 'Pick something other than the default.' }
  if (!setOperatorPassword(operator.email, hashPassword(next))) {
    return { ok: false, error: 'Could not save the new password.' }
  }
  revalidatePath('/', 'layout')
  return { ok: true }
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
    return { ok: false, error: 'Could not save the key: ' + String(e) }
  }
  await notifyGateway()
  revalidatePath('/keys')
  return { ok: true, secret: minted.full, keyId: minted.keyId }
}
