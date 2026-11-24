import './globals.css'
import type { ReactNode } from 'react'
import { IBM_Plex_Sans, JetBrains_Mono } from 'next/font/google'
import { operatorGate } from '../lib/auth'
import { MIN_PASSWORD_LENGTH } from '../lib/password'
import { ChangePassword } from '../components/ChangePassword'
import { Providers } from './providers'
import { ApplicationShell } from '../components/ApplicationShell'

// Self-hosted at build time rather than fetched from a CDN at runtime: this is
// a self-hosted tool, and an operator console should not depend on an external
// request to render its own text.
const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-mono',
})

// Inter is not on Google Fonts under a weight set that matches the spec's
// 400/500/600 cleanly alongside Plex; Plex Sans is the same humanist grotesque
// family the spec names as the alternative, and pairs with Plex-adjacent mono.
const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-sans',
})

export const metadata = {
  title: 'LogerHub',
  description: 'Every request. Every insight.',
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Decided in one place, and fails closed: see operatorGate. Checked here rather
  // than per page because a forced change has to be unavoidable, and anything
  // that lists routes to protect eventually misses one.
  const gate = await operatorGate()
  return (
    <html lang="en" className={sans.variable + ' ' + mono.variable}>
      <body>
        <Providers>
          {gate.state === 'must-change' ? (
            <ChangePassword email={gate.email} forced minLength={MIN_PASSWORD_LENGTH} />
          ) : gate.state === 'active' ? (
            <ApplicationShell email={gate.email}>{children}</ApplicationShell>
          ) : (
            children
          )}
        </Providers>
      </body>
    </html>
  )
}
