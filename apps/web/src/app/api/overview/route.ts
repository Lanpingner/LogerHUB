import { currentOperator } from '../../../lib/auth'
import { overview } from '../../../lib/server-queries'
import { minutesFor } from '../../../lib/tokens'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  if (!(await currentOperator())) return new Response('unauthorised', { status: 401 })
  const url = new URL(req.url)
  const minutes = minutesFor(url.searchParams.get('range') ?? '1h')
  return Response.json(overview(minutes), { headers: { 'cache-control': 'no-store' } })
}
