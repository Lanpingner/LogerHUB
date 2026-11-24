'use client'

import { useState, useTransition } from 'react'
import { KeyRound, ShieldAlert } from 'lucide-react'
import { changePasswordAction } from '../app/actions'
import { C, MONO } from '../lib/tokens'

const field: React.CSSProperties = {
  background: C.raised,
  border: '1px solid ' + C.border,
  borderRadius: 4,
  color: C.text,
  font: '13px ' + MONO,
  padding: '8px 10px',
  width: '100%',
}

/**
 * Shown instead of the console — not merely linked from it — while the account
 * still has its bootstrap password. `forced` separates the two readings: the
 * first login, where the screen needs to explain why it is here, and a voluntary
 * change from the settings page.
 */
export function ChangePassword({ email, forced, minLength }: { email: string; forced: boolean; minLength: number }) {
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [pending, start] = useTransition()

  function submit(form: FormData) {
    const next = String(form.get('next') ?? '')
    const confirm = String(form.get('confirm') ?? '')
    setError(null)
    // Checked here for a quick answer and again on the server, which is the one
    // that counts: this form is a convenience, not the boundary.
    if (next !== confirm) return setError('The two passwords do not match.')
    if (next.length < minLength) return setError(`Use at least ${minLength} characters.`)
    start(async () => {
      const result = await changePasswordAction(String(form.get('current') ?? ''), next)
      if (result.ok) setDone(true)
      else setError(result.error)
    })
  }

  if (done) {
    return (
      <Shell>
        <p style={{ color: C.success, fontSize: 13, margin: '0 0 14px' }}>Password changed.</p>
        <a href="/" style={{ color: C.accent, fontSize: 13 }}>
          Open the console
        </a>
      </Shell>
    )
  }

  return (
    <Shell>
      {forced ? (
        <div
          style={{
            display: 'flex',
            gap: 9,
            alignItems: 'flex-start',
            border: '1px solid ' + C.warning,
            borderLeftWidth: 3,
            borderRadius: 4,
            background: 'rgba(250,204,21,0.07)',
            padding: '10px 12px',
            marginBottom: 16,
          }}
        >
          <ShieldAlert size={15} color={C.warning} style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 12, color: C.text, lineHeight: 1.5 }}>
            This account still has the password it was created with, so anyone who knows it can reach your logs.
            Nothing else opens until you change it.
          </div>
        </div>
      ) : null}

      {error ? (
        <div
          style={{
            border: '1px solid ' + C.error,
            borderLeftWidth: 3,
            borderRadius: 4,
            background: 'rgba(248,113,113,0.08)',
            color: C.error,
            padding: '9px 12px',
            fontSize: 12,
            marginBottom: 14,
          }}
        >
          {error}
        </div>
      ) : null}

      <form action={submit} style={{ display: 'grid', gap: 12 }}>
        <Row label="Signed in as">
          <div style={{ font: '13px ' + MONO, color: C.muted, padding: '8px 0' }}>{email}</div>
        </Row>
        <Row label="Current password">
          <input name="current" type="password" required autoComplete="current-password" style={field} />
        </Row>
        <Row label={`New password (${minLength}+ characters)`}>
          <input name="next" type="password" required autoFocus autoComplete="new-password" style={field} />
        </Row>
        <Row label="New password again">
          <input name="confirm" type="password" required autoComplete="new-password" style={field} />
        </Row>
        <button
          type="submit"
          disabled={pending}
          style={{
            background: C.accent,
            border: 'none',
            borderRadius: 4,
            color: '#07120B',
            cursor: pending ? 'default' : 'pointer',
            font: '600 13px ' + MONO,
            marginTop: 4,
            opacity: pending ? 0.6 : 1,
            padding: '9px 12px',
          }}
        >
          {pending ? 'Changing…' : 'Change password'}
        </button>
      </form>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="signin-page">
      <div style={{ width: 360 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 22 }}>
          <KeyRound size={15} color={C.accent} />
          <span style={{ font: '600 15px ' + MONO, letterSpacing: '-0.02em', color: C.text }}>Set a password</span>
        </div>
        <div style={{ background: C.panel, border: '1px solid ' + C.border, borderRadius: 4, padding: 16 }}>{children}</div>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 4 }}>
      <span style={{ fontSize: 11, color: C.muted }}>{label}</span>
      {children}
    </label>
  )
}
