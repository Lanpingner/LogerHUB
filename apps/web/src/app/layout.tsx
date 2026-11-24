import './globals.css'
import type { ReactNode } from 'react'
import { currentOperator } from '../lib/auth'
import { Providers } from './providers'
import { ApplicationShell } from '../components/ApplicationShell'

export const metadata = {
  title: 'LogerHub',
  description: 'Every request. Every insight.',
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const operator = await currentOperator()
  return (
    <html lang="en">
      <body>
        <Providers>
          {operator ? <ApplicationShell email={operator.email}>{children}</ApplicationShell> : children}
        </Providers>
      </body>
    </html>
  )
}
