import './globals.css'
import type { ReactNode } from 'react'
import { currentOperator, logout } from '../lib/auth'
import { redirect } from 'next/navigation'

export const metadata = {
  title: 'Logguber',
  description: 'Logs and API usage for your services',
}

async function signOut() {
  'use server'
  await logout()
  redirect('/login')
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const operator = await currentOperator()
  return (
    <html lang="en">
      <body>
        {operator ? (
          <nav className="nav">
            <span className="brand">Logguber</span>
            <a href="/">Search</a>
            <a href="/live">Live</a>
            <a href="/usage">Usage</a>
            <a href="/admin">Admin</a>
            <span className="spacer" />
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>{operator.email}</span>
            <form action={signOut}>
              <button type="submit">Sign out</button>
            </form>
          </nav>
        ) : null}
        <main>{children}</main>
      </body>
    </html>
  )
}
