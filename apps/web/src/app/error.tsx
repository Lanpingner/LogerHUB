'use client'

import { useEffect } from 'react'
import { TriangleAlert } from 'lucide-react'
import { C, MONO } from '../lib/tokens'

/**
 * Catches a render failure in a page rather than letting it take the whole
 * response down with it. That containment matters beyond the message: a server
 * action's reply carries a fresh render of the current route, so without a
 * boundary here a page that throws turns an action that SUCCEEDED into an error
 * at the caller — which is how a completed password change came back as
 * "the server could not complete that".
 *
 * Production builds strip the message, so the digest is shown: it is the one
 * thing that ties this screen to the real error in the server's log.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Also in the browser console, so it survives navigating away from here.
    console.error('console render failed', error)
  }, [error])

  return (
    <div style={{ padding: 24, maxWidth: 680 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <TriangleAlert size={16} color={C.error} />
        <span style={{ font: '600 14px ' + MONO, color: C.text }}>This page could not be rendered</span>
      </div>

      <p style={{ color: C.text2, fontSize: 13, lineHeight: 1.6, margin: '0 0 14px' }}>
        The rest of the console still works — try another page from the sidebar. If this one keeps failing, the
        server&apos;s log has the full error:
      </p>

      <pre
        style={{
          margin: '0 0 14px',
          padding: 12,
          background: C.bg,
          border: '1px solid ' + C.border,
          borderRadius: 4,
          color: C.text2,
          font: '11.5px ' + MONO,
          overflowX: 'auto',
        }}
      >
        docker compose logs web{error.digest ? ` | grep ${error.digest}` : ''}
      </pre>

      {error.digest ? (
        <p style={{ color: C.muted, fontSize: 11.5, margin: '0 0 14px' }}>
          digest <span style={{ fontFamily: MONO, color: C.text2 }}>{error.digest}</span>
        </p>
      ) : null}

      <button
        onClick={reset}
        style={{
          background: C.raised,
          border: '1px solid ' + C.border,
          borderRadius: 4,
          color: C.text,
          cursor: 'pointer',
          font: '12px ' + MONO,
          padding: '7px 12px',
        }}
      >
        Try again
      </button>
    </div>
  )
}
