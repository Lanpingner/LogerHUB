import './globals.css'
import type { ReactNode } from 'react'
import { IBM_Plex_Sans, JetBrains_Mono } from 'next/font/google'
import { currentOperator } from '../lib/auth'
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
  const operator = await currentOperator()
  return (
    <html lang="en" className={sans.variable + ' ' + mono.variable}>
      <body>
        <Providers>
          {operator ? <ApplicationShell email={operator.email}>{children}</ApplicationShell> : children}
        </Providers>
      </body>
    </html>
  )
}
