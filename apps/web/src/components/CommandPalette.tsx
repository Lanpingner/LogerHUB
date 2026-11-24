'use client'

import Dialog from '@mui/material/Dialog'
import Box from '@mui/material/Box'
import InputBase from '@mui/material/InputBase'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CornerDownLeft, Search } from 'lucide-react'
import { useConsole } from '../store/console'
import { C, MONO, TIME_RANGES } from '../lib/tokens'
import { NAV_ITEMS } from './NavigationSidebar'

interface Command {
  id: string
  label: string
  group: string
  hint?: string
  run: () => void
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter()
  const { setRange, toggleSidebar, toggleHistogram, setRawMode, rawMode, setStreaming, streaming, queryHistory, patchFilters } =
    useConsole()
  const [text, setText] = useState('')
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const commands = useMemo<Command[]>(() => {
    const out: Command[] = NAV_ITEMS.map((item) => ({
      id: 'go:' + item.href,
      label: item.label,
      group: 'Go to',
      hint: item.ready ? undefined : 'not built yet',
      run: () => router.push(item.href),
    }))

    for (const r of TIME_RANGES) {
      out.push({ id: 'range:' + r.key, label: r.label, group: 'Time range', run: () => setRange(r.key) })
    }

    out.push(
      { id: 'act:sidebar', label: 'Toggle sidebar', group: 'View', hint: 'Ctrl+B', run: toggleSidebar },
      { id: 'act:histogram', label: 'Toggle traffic histogram', group: 'View', run: toggleHistogram },
      {
        id: 'act:raw',
        label: rawMode ? 'Switch to table view' : 'Switch to raw terminal output',
        group: 'View',
        run: () => setRawMode(!rawMode),
      },
      {
        id: 'act:stream',
        label: streaming ? 'Pause live streaming' : 'Resume live streaming',
        group: 'Stream',
        hint: 'Space',
        run: () => setStreaming(!streaming),
      },
      { id: 'act:clearfilters', label: 'Clear application and environment filters', group: 'Filters', run: () => patchFilters({ application: '', service: '', environment: '' }) },
    )

    for (const q of queryHistory.slice(0, 8)) {
      out.push({
        id: 'q:' + q,
        label: q,
        group: 'Recent queries',
        run: () => {
          patchFilters({ query: q })
          router.push('/live')
        },
      })
    }
    return out
  }, [router, setRange, toggleSidebar, toggleHistogram, rawMode, setRawMode, streaming, setStreaming, queryHistory, patchFilters])

  const filtered = useMemo(() => {
    const needle = text.trim().toLowerCase()
    if (!needle) return commands.slice(0, 40)
    return commands
      .filter((c) => (c.label + ' ' + c.group).toLowerCase().includes(needle))
      .slice(0, 40)
  }, [commands, text])

  useEffect(() => {
    setIndex(0)
  }, [text])

  useEffect(() => {
    if (open) setText('')
  }, [open])

  const choose = (c?: Command) => {
    if (!c) return
    c.run()
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      slotProps={{ paper: { sx: { background: C.panel, mt: '8vh', alignSelf: 'flex-start' } } }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 3, height: 44, borderBottom: '1px solid ' + C.border }}>
        <Search size={15} color={C.muted} />
        <InputBase
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Jump to a page, change the range, run a recent query…"
          sx={{ flex: 1, fontSize: 13, color: C.text }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex((i) => Math.min(filtered.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              choose(filtered[index])
            }
          }}
        />
      </Box>
      <Box ref={listRef} sx={{ maxHeight: 420, overflowY: 'auto', py: 1 }}>
        {filtered.length === 0 ? (
          <Box sx={{ px: 3, py: 4, color: C.muted, fontSize: 12 }}>Nothing matches “{text}”.</Box>
        ) : (
          filtered.map((c, i) => {
            const firstOfGroup = i === 0 || filtered[i - 1].group !== c.group
            return (
              <Box key={c.id}>
                {firstOfGroup ? (
                  <Box sx={{ px: 3, pt: i ? 2 : 0.5, pb: 0.5, fontSize: 10, letterSpacing: '0.08em', color: C.muted }}>
                    {c.group.toUpperCase()}
                  </Box>
                ) : null}
                <Box
                  role="option"
                  aria-selected={i === index}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => choose(c)}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 2,
                    height: 28,
                    px: 3,
                    cursor: 'pointer',
                    background: i === index ? C.selected : 'transparent',
                    color: i === index ? C.text : C.text2,
                    fontSize: 12.5,
                  }}
                >
                  <Box component="span" sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.label}
                  </Box>
                  {c.hint ? (
                    <Box component="span" sx={{ fontFamily: MONO, fontSize: 10, color: C.muted }}>
                      {c.hint}
                    </Box>
                  ) : null}
                  {i === index ? <CornerDownLeft size={12} color={C.muted} /> : null}
                </Box>
              </Box>
            )
          })
        )}
      </Box>
    </Dialog>
  )
}
