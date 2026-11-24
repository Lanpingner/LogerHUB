'use client'

import Box from '@mui/material/Box'
import { C } from '../lib/tokens'

/** An honest empty state. The spec forbids controls that do nothing, so an
 *  unbuilt workspace says what it will hold and what it needs first, rather
 *  than showing a shell of dead buttons. */
export function NotBuilt({ title, purpose, needs }: { title: string; purpose: string; needs: string[] }) {
  return (
    <Box sx={{ flex: 1, overflow: 'auto', p: 4 }}>
      <Box sx={{ maxWidth: 640 }}>
        <Box sx={{ fontSize: 15, fontWeight: 600, mb: 1 }}>{title}</Box>
        <Box sx={{ fontSize: 12.5, color: C.text2, lineHeight: 1.75, mb: 3 }}>{purpose}</Box>
        <Box sx={{ fontSize: 11, color: C.muted, mb: 1 }}>Not built yet. It needs:</Box>
        <Box component="ul" sx={{ m: 0, pl: 3, display: 'grid', gap: 0.75 }}>
          {needs.map((n) => (
            <Box component="li" key={n} sx={{ fontSize: 12, color: C.text2, lineHeight: 1.6 }}>
              {n}
            </Box>
          ))}
        </Box>
        <Box sx={{ mt: 3, fontSize: 11.5, color: C.muted, lineHeight: 1.7 }}>
          Everything in the sidebar marked <em>soon</em> is in this state. The workspaces without that mark are
          running against your real gateway.
        </Box>
      </Box>
    </Box>
  )
}
