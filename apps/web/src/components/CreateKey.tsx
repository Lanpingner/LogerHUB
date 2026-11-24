'use client'

import { useState, useTransition } from 'react'
import Box from '@mui/material/Box'
import { Check, Copy, KeyRound, TriangleAlert } from 'lucide-react'
import { createKeyAction } from '../app/actions'
import { C, MONO } from '../lib/tokens'

const input = {
  background: C.bg,
  border: '1px solid ' + C.border,
  borderRadius: '4px',
  color: C.text,
  fontFamily: MONO,
  fontSize: 12,
  padding: '7px 9px',
  width: '100%',
  outline: 'none',
  '&:focus': { borderColor: C.accent },
} as const

/**
 * Minting in the browser is a deliberate change: the secret now passes through a
 * page, where the CLI kept it on the server. It is shown exactly once and never
 * stored, which is the same bargain GitHub and Stripe make — worth it so a key
 * can be issued without shell access to the gateway.
 */
export function CreateKey({ knownServices }: { knownServices: string[] }) {
  const [minted, setMinted] = useState<{ secret: string; keyId: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [pending, start] = useTransition()

  function submit(form: FormData) {
    setError(null)
    start(async () => {
      const result = await createKeyAction(
        String(form.get('name') ?? ''),
        String(form.get('services') ?? ''),
        String(form.get('envs') ?? ''),
        String(form.get('allowlist') ?? ''),
      )
      if (result.ok) setMinted({ secret: result.secret, keyId: result.keyId })
      else setError(result.error)
    })
  }

  if (minted) {
    return (
      <Box>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', mb: 1.5 }}>
          <TriangleAlert size={14} color={C.warning} style={{ flexShrink: 0, marginTop: 2 }} />
          <Box sx={{ fontSize: 11.5, color: C.text, lineHeight: 1.6 }}>
            Copy this now. Only its hash is stored, so this is the one time it can be shown.
          </Box>
        </Box>
        <Box
          component="pre"
          sx={{
            m: 0,
            p: 1.5,
            background: C.bg,
            border: '1px solid ' + C.accent,
            borderRadius: '4px',
            fontFamily: MONO,
            fontSize: 11,
            color: C.accent,
            overflowX: 'auto',
            userSelect: 'all',
          }}
        >
          {minted.secret}
        </Box>
        <Box sx={{ display: 'flex', gap: 1, mt: 1.5 }}>
          <Btn
            onClick={() => {
              void navigator.clipboard?.writeText(minted.secret).then(
                () => setCopied(true),
                () => setCopied(false),
              )
            }}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? 'Copied' : 'Copy'}
          </Btn>
          <Btn
            onClick={() => {
              setMinted(null)
              setCopied(false)
            }}
          >
            Done
          </Btn>
        </Box>
      </Box>
    )
  }

  return (
    <Box component="form" action={submit} sx={{ display: 'grid', gap: 1.25 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 11.5, color: C.text2, lineHeight: 1.6 }}>
        <KeyRound size={13} color={C.accent} />
        One key per service, so a compromised host can only forge its own logs.
      </Box>

      {error ? (
        <Box
          sx={{
            border: '1px solid ' + C.error,
            borderLeftWidth: '3px',
            borderRadius: '4px',
            background: 'rgba(248,113,113,0.08)',
            color: C.error,
            fontSize: 11.5,
            p: '7px 10px',
          }}
        >
          {error}
        </Box>
      ) : null}

      <Field label="Name" hint="how it appears in this list">
        <Box component="input" name="name" required placeholder="office-api" sx={input} />
      </Field>
      <Field label="Services" hint="comma separated; the only ones it may write">
        <Box
          component="input"
          name="services"
          required
          placeholder={knownServices.slice(0, 2).join(', ') || 'office-api'}
          list="known-services"
          sx={input}
        />
        <datalist id="known-services">
          {knownServices.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </Field>
      <Field label="Environments" hint="required: an unscoped key can invent streams">
        <Box component="input" name="envs" required defaultValue="prod" sx={input} />
      </Field>
      <Field label="Allowed from" hint="optional IPs or CIDRs; empty means anywhere">
        <Box component="input" name="allowlist" placeholder="10.0.0.0/8" sx={input} />
      </Field>

      <Box
        component="button"
        type="submit"
        disabled={pending}
        sx={{
          background: C.accent,
          border: 'none',
          borderRadius: '4px',
          color: '#07120B',
          cursor: pending ? 'default' : 'pointer',
          fontFamily: MONO,
          fontSize: 12,
          fontWeight: 600,
          mt: 0.5,
          opacity: pending ? 0.6 : 1,
          p: '8px 10px',
        }}
      >
        {pending ? 'Creating…' : 'Create key'}
      </Box>
    </Box>
  )
}

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <Box component="label" sx={{ display: 'grid', gap: 0.5 }}>
      <Box sx={{ fontSize: 10.5, color: C.muted }}>
        {label} <Box component="span" sx={{ color: '#3B4857' }}>· {hint}</Box>
      </Box>
      {children}
    </Box>
  )
}

function Btn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <Box
      component="button"
      type="button"
      onClick={onClick}
      sx={{
        alignItems: 'center',
        background: C.raised,
        border: '1px solid ' + C.border,
        borderRadius: '4px',
        color: C.text,
        cursor: 'pointer',
        display: 'flex',
        fontFamily: MONO,
        fontSize: 11.5,
        gap: 0.75,
        p: '6px 10px',
        '&:hover': { borderColor: C.accent },
      }}
    >
      {children}
    </Box>
  )
}
