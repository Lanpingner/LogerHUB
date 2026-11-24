import { currentOperator } from '../../../lib/auth'
import { tree } from '../../../lib/server-queries'
import { settings } from '../../../lib/store'
import { minutesFor } from '../../../lib/tokens'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  if (!(await currentOperator())) return new Response('unauthorised', { status: 401 })
  const url = new URL(req.url)
  const minutes = minutesFor(url.searchParams.get('range') ?? '24h')
  return Response.json(
    { environments: tree(minutes), levels: settings().levels },
    { headers: { 'cache-control': 'no-store' } },
  )
}
