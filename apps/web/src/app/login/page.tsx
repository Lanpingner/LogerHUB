import { redirect } from 'next/navigation'
import { currentOperator, login } from '../../lib/auth'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  if (await currentOperator()) redirect('/')
  const { error } = await searchParams

  async function submit(form: FormData) {
    'use server'
    const email = String(form.get('email') ?? '')
    const password = String(form.get('password') ?? '')
    const result = await login(email, password)
    if (!result.ok) redirect('/login?error=' + encodeURIComponent(result.error))
    redirect('/')
  }

  return (
    <div className="login">
      <h1>Sign in to Logguber</h1>
      {error ? <div className="banner">{error}</div> : null}
      <form action={submit} className="panel" style={{ display: 'grid', gap: 12 }}>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="username" required autoFocus />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        <button className="primary" type="submit">
          Sign in
        </button>
      </form>
      <p className="hint" style={{ marginTop: 14 }}>
        No account yet? Create one with the gateway&apos;s CLI:
        <br />
        <code>pnpm --filter @logguber/ingest seed operator you@example.com &lt;password&gt;</code>
      </p>
    </div>
  )
}
