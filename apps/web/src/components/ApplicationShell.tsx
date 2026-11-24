'use client'

import Box from '@mui/material/Box'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useConsole } from '../store/console'
import { C } from '../lib/tokens'
import { GlobalToolbar } from './GlobalToolbar'
import { NavigationSidebar } from './NavigationSidebar'
import { StatusBar, type StatusFacts } from './StatusBar'
import { CommandPalette } from './CommandPalette'
import { StatusFactsContext } from './status-context'

/** Full-viewport shell: the page never scrolls, individual panels do. */
export function ApplicationShell({ email, children }: { email: string; children: ReactNode }) {
  const router = useRouter()
  const { toggleSidebar, toggleBottomPanel, setStreaming, streaming, setSidebarWidth, sidebarWidth, sidebarCollapsed } =
    useConsole()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [facts, setFacts] = useState<StatusFacts>({})
  const [dragging, setDragging] = useState(false)

  const publish = useCallback((next: StatusFacts) => {
    setFacts((prev) => {
      const merged = { ...prev, ...next }
      const same =
        prev.matching === merged.matching &&
        prev.tookMs === merged.tookMs &&
        prev.connection === merged.connection &&
        Math.round((prev.ingestRate ?? -1) * 10) === Math.round((merged.ingestRate ?? -1) * 10)
      return same ? prev : merged
    })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLElement &&
        (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggleSidebar()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        toggleBottomPanel()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        router.push('/live')
        return
      }
      if (e.key === ' ' && !typing) {
        e.preventDefault()
        setStreaming(!streaming)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [router, toggleSidebar, toggleBottomPanel, setStreaming, streaming])

  // Sidebar resize: pointer events on a 4px gutter, persisted by the store.
  useEffect(() => {
    if (!dragging) return
    const move = (e: PointerEvent) => setSidebarWidth(e.clientX)
    const up = () => setDragging(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [dragging, setSidebarWidth])

  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column', background: C.bg, overflow: 'hidden' }}>
      <GlobalToolbar email={email} onOpenPalette={() => setPaletteOpen(true)} />
      <Box sx={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <NavigationSidebar />
        {!sidebarCollapsed ? (
          <Box
            onPointerDown={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            role="separator"
            aria-label="Resize sidebar"
            aria-valuenow={sidebarWidth}
            sx={{
              width: 4,
              marginLeft: '-2px',
              cursor: 'col-resize',
              flex: 'none',
              zIndex: 2,
              '&:hover': { background: 'rgba(74,222,128,0.25)' },
              background: dragging ? C.accent : 'transparent',
            }}
          />
        ) : null}
        <Box component="main" sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <StatusFactsContext.Provider value={publish}>{children}</StatusFactsContext.Provider>
        </Box>
      </Box>
      <StatusBar facts={facts} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <style>{`@keyframes lhPulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }`}</style>
    </Box>
  )
}
