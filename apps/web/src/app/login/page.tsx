import { redirect } from 'next/navigation'
import { currentOperator, login } from '../../lib/auth'

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentOperator()) redirect('/')
  const { error } = await searchParams

  async function submit(form: FormData) {
    'use server'
    const result = await login(String(form.get('email') ?? ''), String(form.get('password') ?? ''))
    if (!result.ok) redirect('/login?error=' + encodeURIComponent(result.error))
    redirect('/')
  }

  return (
    <div className="signin-page">
      <form action={submit} style={{ width: 320 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 22 }}>
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 17,
              fontWeight: 600,
              letterSpacing: '-0.02em',
            }}
          >
            LogerHub
          </span>
          <span style={{ fontSize: 11, color: '#526171' }}>Every request. Every insight.</span>
        </div>

        {error ? (
          <div
            style={{
              border: '1px solid #F87171',
              borderLeftWidth: 3,
              borderRadius: 4,
              background: 'rgba(248,113,113,0.08)',
              color: '#F87171',
              padding: '9px 12px',
              fontSize: 12,
              marginBottom: 14,
            }}
          >
            {error}
          </div>
        ) : null}

        <div style={{ display: 'grid', gap: 12, background: '#0D131A', border: '1px solid #25313D', borderRadius: 4, padding: 16 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 11, color: '#8492A3' }}>Email</span>
            <input
              name="email"
              type="email"
              required
              autoFocus
              autoComplete="username"
              style={{
                background: '#131B24',
                border: '1px solid #25313D',
                borderRadius: 4,
                color: '#DCE4ED',
                font: 'inherit',
                fontSize: 12,
                padding: '6px 9px',
              }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 11, color: '#8492A3' }}>Password</span>
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              style={{
                background: '#131B24',
                border: '1px solid #25313D',
                borderRadius: 4,
                color: '#DCE4ED',
                font: 'inherit',
                fontSize: 12,
                padding: '6px 9px',
              }}
            />
          </label>
          <button
            type="submit"
            style={{
              background: '#4ADE80',
              border: 'none',
              borderRadius: 4,
              color: '#07140C',
              font: 'inherit',
              fontSize: 12,
              fontWeight: 600,
              padding: '7px 10px',
              cursor: 'pointer',
            }}
          >
            Sign in
          </button>
        </div>

        <p style={{ fontSize: 11, color: '#526171', lineHeight: 1.7, marginTop: 14 }}>
          Accounts are created on the server:
          <br />
          <code style={{ fontFamily: "'JetBrains Mono', monospace", color: '#8492A3' }}>
            pnpm --filter @logguber/ingest seed operator you@example.com &lt;password&gt;
          </code>
        </p>
      </form>
    </div>
  )
}
