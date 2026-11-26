import { NextResponse, type NextRequest } from 'next/server'

/**
 * Sends an unauthenticated request to the login page with a real redirect.
 *
 * Named `proxy` rather than `middleware`: Next 16 deprecated that convention
 * and warns on it at build time.
 *
 * The pages already refuse to render without a session, but the root route has
 * a loading boundary, so Next flushes the shell before the page's `redirect()`
 * runs and the redirect arrives as a meta refresh inside a 200. A browser still
 * ends up at /login; anything else — a monitor, a scanner, a script — sees a
 * 200 and concludes the console is open. This runs before rendering, so the
 * status can still be set.
 *
 * This is NOT the authentication boundary and must never be treated as one. It
 * checks that a session cookie is PRESENT, not that it is valid: verifying the
 * signature needs SESSION_SECRET and node:crypto, and a gate that fails open on
 * a misconfigured secret would be worse than no gate. Every page calls
 * `currentOperator()` and every action and API route calls `activeOperator()`,
 * which verify properly against the signing key and the operator table. A
 * forged cookie gets past this and is then refused there.
 */
const COOKIE = 'logguber_session'

export function proxy(req: NextRequest) {
  if (req.cookies.has(COOKIE)) return NextResponse.next()
  const url = req.nextUrl.clone()
  url.pathname = '/login'
  url.search = ''
  return NextResponse.redirect(url, 307)
}

export const config = {
  /**
   * Everything except the login page itself, the API routes (which answer 401
   * rather than redirect, because a redirect to HTML is useless to a caller
   * expecting JSON), Next's own assets and the favicon.
   */
  matcher: ['/((?!login|api/|_next/|favicon).*)'],
}
