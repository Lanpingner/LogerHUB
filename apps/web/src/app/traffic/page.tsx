import { redirect } from 'next/navigation'
import { currentOperator } from '../../lib/auth'
import { NotBuilt } from '../../components/NotBuilt'

export default async function Page() {
  if (!(await currentOperator())) redirect('/login')
  return (
    <NotBuilt
      title="Traffic Analytics"
      purpose="Traffic shape over time by client, endpoint and region, with comparisons between periods."
      needs={['Per-bucket breakdowns in the usage counters, which currently store totals per hierarchy prefix only', 'A second time window per query so two periods can be compared']}
    />
  )
}
