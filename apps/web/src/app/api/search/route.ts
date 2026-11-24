import { currentOperator } from '../../../lib/auth'
import { bucketsFromRows, searchLogs, volume } from '../../../lib/server-queries'
import { minutesFor } from '../../../lib/tokens'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  if (!(await currentOperator())) return new Response('unauthorised', { status: 401 })
  const url = new URL(req.url)
  const minutes = minutesFor(url.searchParams.get('range') ?? '1h')
  const limit = Math.min(2000, Number(url.searchParams.get('limit')) || 500)

  const outcome = await searchLogs({
    q: url.searchParams.get('q') ?? '',
    minutes,
    limit,
    service: url.searchParams.get('service') || undefined,
    env: url.searchParams.get('env') || undefined,
    level: url.searchParams.get('level') || undefined,
  })

  // Under six hours the hourly counters are too coarse to show a shape, so the
  // histogram comes from the sampled lines — but only when the sample actually
  // reaches back across the window. A limit-truncated sample would otherwise
  // draw a spike at the right edge and nothing before it, which is a lie.
  const oldest = outcome.rows.length ? Math.min(...outcome.rows.map((r) => r.ts)) : Date.now()
  const covers = Date.now() - oldest >= minutes * 60_000 * 0.8
  const buckets =
    minutes <= 360 && outcome.rows.length && covers
      ? bucketsFromRows(outcome.rows, minutes)
      : volume(minutes, url.searchParams.get('service') || undefined)

  return Response.json({ ...outcome, buckets }, { headers: { 'cache-control': 'no-store' } })
}
