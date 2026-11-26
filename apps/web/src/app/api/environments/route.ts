import { activeOperator } from '../../../lib/auth'
import { environments } from '../../../lib/server-queries'
import { minutesFor } from '../../../lib/tokens'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  if (!(await activeOperator())) return new Response('unauthorised', { status: 401 })
  const url = new URL(req.url)
  const minutes = minutesFor(url.searchParams.get('range') ?? '1h')
  const out = await environments(minutes)
  return Response.json(out, { headers: { 'cache-control': 'no-store' } })
}
