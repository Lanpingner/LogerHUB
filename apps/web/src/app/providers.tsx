'use client'

import type { ReactNode } from 'react'
import { useState } from 'react'
import { AppRouterCacheProvider } from '@mui/material-nextjs/v13-appRouter'
import { ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { theme } from '../lib/theme'

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Dashboards refetch on an interval; keeping data while a refetch is
            // in flight means charts hold their previous render instead of flashing.
            staleTime: 5_000,
            refetchOnWindowFocus: false,
            retry: 1,
            placeholderData: (prev: unknown) => prev,
          },
        },
      }),
  )
  return (
    <AppRouterCacheProvider options={{ key: 'lh', enableCssLayer: true }}>
      <ThemeProvider theme={theme} defaultMode="dark">
        <CssBaseline />
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </ThemeProvider>
    </AppRouterCacheProvider>
  )
}
