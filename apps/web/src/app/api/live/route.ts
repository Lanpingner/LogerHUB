import { currentOperator } from '../../../lib/auth'

const INGEST_URL = (process.env.INGEST_INTERNAL_URL ?? 'http://localhost:8080').replace(/\/$/, '')
const CONSOLE_SECRET = process.env.CONSOLE_SECRET ?? ''

export const dynamic = 'force-dynamic'

/** Relays the gateway's live stream to the browser.
 *
 *  The browser only ever talks to this origin, so the gateway's shared secret
 *  stays server-side and the existing session cookie is the only thing the
 *  browser needs. Lines arrive as the gateway accepts them — there is no
 *  storage round trip, which is the whole point of fanning out at the gateway
 *  rather than polling Loki's tail endpoint. */
export async function GET(req: Request) {
  if (!(await currentOperator())) {
    return new Response('unauthorised', { status: 401 })
  }
  if (!CONSOLE_SECRET) {
    return new Response('CONSOLE_SECRET is not set on the server', { status: 500 })
  }

  const incoming = new URL(req.url)
  const upstream = new URL(INGEST_URL + '/internal/live')
  for (const k of ['services', 'envs', 'levels', 'dims'] as const) {
    const v = incoming.searchParams.get(k)
    if (v) upstream.searchParams.set(k, v)
  }

  let res: Response
  try {
    res = await fetch(upstream, {
      signal: req.signal,
      cache: 'no-store',
      // Header, not a query parameter: URLs end up in proxy and access logs.
      headers: { 'x-console-secret': CONSOLE_SECRET },
    })
  } catch (e) {
    return new Response('Could not reach the gateway at ' + INGEST_URL + ': ' + (e as Error).message, { status: 502 })
  }
  if (!res.ok || !res.body) {
    return new Response('Gateway returned ' + res.status, { status: 502 })
  }

  return new Response(res.body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}
