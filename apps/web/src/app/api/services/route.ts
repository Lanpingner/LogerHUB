import { activeOperator } from '../../../lib/auth'
import { services } from '../../../lib/server-queries'
import { minutesFor } from '../../../lib/tokens'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  if (!(await activeOperator())) return new Response('unauthorised', { status: 401 })
  const minutes = minutesFor(new URL(req.url).searchParams.get('range') ?? '1h')
  return Response.json(await services(minutes), { headers: { 'cache-control': 'no-store' } })
}
