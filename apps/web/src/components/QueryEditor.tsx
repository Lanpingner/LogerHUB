'use client'

import Box from '@mui/material/Box'
import InputBase from '@mui/material/InputBase'
import Tooltip from '@mui/material/Tooltip'
import IconButton from '@mui/material/IconButton'
import { useEffect, useMemo, useRef, useState } from 'react'
import { CircleAlert, History, Star, X } from 'lucide-react'
import { FIELDS, parse, suggest, type Suggestion } from '../lib/query'
import { useConsole } from '../store/console'
import { C, MONO } from '../lib/tokens'

/** Highlighted overlay behind a transparent input: cheap syntax colouring
 *  without pulling a full editor into the console toolbar. */
function Highlighted({ text }: { text: string }) {
  const parts = useMemo(() => {
    const out: { text: string; kind: 'field' | 'op' | 'value' | 'bool' | 'plain' }[] = []
    for (const raw of text.split(/(\s+)/)) {
      if (!raw) continue
      if (/^\s+$/.test(raw)) {
        out.push({ text: raw, kind: 'plain' })
        continue
      }
      const upper = raw.toUpperCase()
      if (upper === 'AND' || upper === 'OR' || upper === 'NOT') {
        out.push({ text: raw, kind: 'bool' })
        continue
      }
      const colon = raw.indexOf(':')
      if (colon > 0 && raw.slice(0, colon).toLowerCase() in FIELDS) {
        out.push({ text: raw.slice(0, colon), kind: 'field' })
        out.push({ text: ':', kind: 'op' })
        out.push({ text: raw.slice(colon + 1), kind: 'value' })
      } else {
        out.push({ text: raw, kind: 'plain' })
      }
    }
    return out
  }, [text])

  const color = { field: C.info, op: C.muted, value: C.accent, bool: C.purple, plain: C.text }
  return (
    <Box
      aria-hidden
      sx={{
        position: 'absolute',
        inset: 0,
        px: 1.5,
        display: 'flex',
        alignItems: 'center',
        fontFamily: MONO,
        fontSize: 12,
        whiteSpace: 'pre',
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      {parts.map((p, i) => (
        <span key={i} style={{ color: color[p.kind] }}>
          {p.text}
        </span>
      ))}
    </Box>
  )
}

export function QueryEditor({
  value,
  onChange,
  onRun,
  services,
  envs,
}: {
  value: string
  onChange: (v: string) => void
  onRun: (v: string) => void
  services: string[]
  envs: string[]
}) {
  const { queryHistory, savedQueries, saveQuery, rememberQuery } = useConsole()
  const [caret, setCaret] = useState(0)
  const [open, setOpen] = useState<'none' | 'suggest' | 'history'>('none')
  const [pick, setPick] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const { issues } = useMemo(() => parse(value), [value])
  const suggestions = useMemo<Suggestion[]>(
    () => (open === 'suggest' ? suggest(value, caret, { services, envs }) : []),
    [open, value, caret, services, envs],
  )

  useEffect(() => setPick(0), [suggestions.length, open])

  const applySuggestion = (s: Suggestion) => {
    const before = value.slice(0, caret).replace(/[^\s]*$/, '')
    const after = value.slice(caret)
    const next = before + s.insert + (after.startsWith(' ') || !after ? '' : ' ') + after
    onChange(next)
    setOpen('none')
    requestAnimationFrame(() => {
      const pos = (before + s.insert).length
      inputRef.current?.setSelectionRange(pos, pos)
      inputRef.current?.focus()
    })
  }

  const run = () => {
    rememberQuery(value)
    onRun(value)
    setOpen('none')
  }

  const items = open === 'history' ? [...savedQueries.map((q) => q.query), ...queryHistory] : []

  return (
    <Box sx={{ position: 'relative', flex: 1, minWidth: 220 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          height: 26,
          background: C.raised,
          border: '1px solid ' + (issues.length ? C.error : C.border),
          borderRadius: '4px',
          position: 'relative',
          '&:focus-within': { borderColor: issues.length ? C.error : C.accent },
        }}
      >
        <Highlighted text={value} />
        <InputBase
          inputRef={inputRef}
          value={value}
          onChange={(e) => {
            onChange(e.target.value)
            setCaret(e.target.selectionStart ?? e.target.value.length)
            setOpen('suggest')
          }}
          onSelect={(e) => setCaret((e.target as HTMLInputElement).selectionStart ?? 0)}
          onFocus={() => setOpen('suggest')}
          onBlur={() => setTimeout(() => setOpen('none'), 120)}
          onKeyDown={(e) => {
            const list = open === 'suggest' ? suggestions : items
            if (e.key === 'ArrowDown' && list.length) {
              e.preventDefault()
              setPick((p) => Math.min(list.length - 1, p + 1))
            } else if (e.key === 'ArrowUp' && list.length) {
              e.preventDefault()
              setPick((p) => Math.max(0, p - 1))
            } else if (e.key === 'Tab' && suggestions.length) {
              e.preventDefault()
              applySuggestion(suggestions[pick])
            } else if (e.key === 'Enter') {
              e.preventDefault()
              if (open === 'suggest' && suggestions.length && (e.ctrlKey || e.metaKey) === false && caret === value.length && value.endsWith(':')) {
                applySuggestion(suggestions[pick])
              } else if (open === 'history' && items.length) {
                onChange(items[pick])
                setOpen('none')
              } else {
                run()
              }
            } else if (e.key === 'Escape') {
              setOpen('none')
            }
          }}
          placeholder="app:atlas status:>=500 duration:>1000"
          sx={{
            flex: 1,
            px: 1.5,
            fontFamily: MONO,
            fontSize: 12,
            color: 'transparent',
            caretColor: C.text,
            '& input::placeholder': { color: C.muted, opacity: 1 },
            '& input': { padding: 0, height: 24 },
          }}
        />
        {value ? (
          <Tooltip title="Clear">
            <IconButton onClick={() => onChange('')} sx={{ mr: 0.5 }} aria-label="Clear query">
              <X size={12} />
            </IconButton>
          </Tooltip>
        ) : null}
        <Tooltip title="Saved queries and history">
          <IconButton
            onClick={() => setOpen(open === 'history' ? 'none' : 'history')}
            sx={{ mr: 0.5 }}
            aria-label="Query history"
          >
            <History size={13} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Save this query">
          <IconButton
            disabled={!value.trim()}
            onClick={() => {
              const name = window.prompt('Name this query', value.slice(0, 40))
              if (name) saveQuery(name, value)
            }}
            sx={{ mr: 0.5 }}
            aria-label="Save query"
          >
            <Star size={13} />
          </IconButton>
        </Tooltip>
      </Box>

      {issues.length ? (
        <Box
          sx={{
            position: 'absolute',
            top: 30,
            left: 0,
            zIndex: 30,
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            px: 1.5,
            py: 0.75,
            background: C.raised,
            border: '1px solid ' + C.error,
            borderRadius: '4px',
            fontSize: 11,
            color: C.error,
            maxWidth: 520,
          }}
        >
          <CircleAlert size={12} />
          {issues[0].message}
        </Box>
      ) : open !== 'none' && (suggestions.length || items.length) ? (
        <Box
          sx={{
            position: 'absolute',
            top: 30,
            left: 0,
            minWidth: 320,
            maxWidth: 560,
            zIndex: 30,
            background: C.raised,
            border: '1px solid ' + C.border,
            borderRadius: '4px',
            maxHeight: 260,
            overflowY: 'auto',
            py: 0.5,
          }}
        >
          {open === 'suggest'
            ? suggestions.map((s, i) => (
                <Box
                  key={s.insert}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    applySuggestion(s)
                  }}
                  onMouseEnter={() => setPick(i)}
                  sx={{
                    display: 'flex',
                    gap: 2,
                    alignItems: 'center',
                    px: 2,
                    height: 24,
                    cursor: 'pointer',
                    background: i === pick ? C.selected : 'transparent',
                  }}
                >
                  <Box sx={{ fontFamily: MONO, fontSize: 11.5, color: C.accent }}>{s.label}</Box>
                  <Box sx={{ fontSize: 10.5, color: C.muted, flex: 1, textAlign: 'right' }}>{s.detail}</Box>
                </Box>
              ))
            : items.map((q, i) => (
                <Box
                  key={q + i}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    onChange(q)
                    setOpen('none')
                  }}
                  onMouseEnter={() => setPick(i)}
                  sx={{
                    px: 2,
                    height: 24,
                    display: 'flex',
                    alignItems: 'center',
                    cursor: 'pointer',
                    fontFamily: MONO,
                    fontSize: 11.5,
                    color: i === pick ? C.text : C.text2,
                    background: i === pick ? C.selected : 'transparent',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {q}
                </Box>
              ))}
          {open === 'history' && !items.length ? (
            <Box sx={{ px: 2, py: 1.5, fontSize: 11, color: C.muted }}>No saved queries yet.</Box>
          ) : null}
        </Box>
      ) : null}
    </Box>
  )
}
