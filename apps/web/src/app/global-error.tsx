'use client'

/**
 * The last resort: a failure in the root layout itself, which replaces even the
 * `<html>` element — so this file cannot rely on the app's fonts, providers or
 * styles, and uses plain inline styles only.
 *
 * The usual cause is the layout's own work failing: reading the operator, or the
 * store the gate consults.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ background: '#080C10', color: '#DCE4ED', fontFamily: 'ui-monospace, Menlo, monospace', margin: 0 }}>
        <div style={{ maxWidth: 620, padding: 32 }}>
          <h1 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 12px', color: '#F87171' }}>
            LogerHub could not start a page
          </h1>
          <p style={{ color: '#8492A3', fontSize: 13, lineHeight: 1.6, margin: '0 0 16px' }}>
            This failed before the console could render anything, so the cause is usually the database the console
            reads — check that it is present and writable at the path the container expects.
          </p>
          <pre
            style={{
              background: '#0D131A',
              border: '1px solid #25313D',
              borderRadius: 4,
              color: '#8492A3',
              fontSize: 11.5,
              margin: '0 0 16px',
              overflowX: 'auto',
              padding: 12,
            }}
          >
            docker compose logs web{error.digest ? ` | grep ${error.digest}` : ''}
          </pre>
          {error.digest ? (
            <p style={{ color: '#526171', fontSize: 11.5, margin: '0 0 16px' }}>digest {error.digest}</p>
          ) : null}
          <button
            onClick={reset}
            style={{
              background: '#131B24',
              border: '1px solid #25313D',
              borderRadius: 4,
              color: '#DCE4ED',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 12,
              padding: '7px 12px',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  )
}
