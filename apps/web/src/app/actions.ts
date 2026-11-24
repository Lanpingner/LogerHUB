'use server'

import { revalidatePath } from 'next/cache'
import { currentOperator, logout } from '../lib/auth'
import { disableKey, putLabel, saveSettings, settings } from '../lib/store'

const INGEST_URL = (process.env.INGEST_INTERNAL_URL ?? 'http://localhost:8080').replace(/\/$/, '')
const CONSOLE_SECRET = process.env.CONSOLE_SECRET ?? ''

/** Server actions are independently addressable POST endpoints: a page's own
 *  auth check does not protect them, so every action re-verifies the session. */
async function requireOperator() {
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
