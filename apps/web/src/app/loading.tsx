/** Shown while a route segment is still resolving. Without it, a navigation
 *  that waits on the server leaves the previous page on screen with no sign
 *  that anything is happening, which reads as the click not registering. */
export default function Loading() {
  return (
    <div
      role="status"
      aria-label="Loading"
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11.5,
        letterSpacing: '0.04em',
        color: '#6b7280',
      }}
    >
      loading…
    </div>
  )
}
