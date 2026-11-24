import { redirect } from 'next/navigation'
import { currentOperator } from '../../lib/auth'
import { NotBuilt } from '../../components/NotBuilt'

export default async function Page() {
  if (!(await currentOperator())) redirect('/login')
  return (
    <NotBuilt
      title="Alerts"
      purpose="Rules on error rate, latency, volume, missing logs and specific exceptions, with thresholds, windows and cooldowns."
      needs={['A rule evaluator running on a schedule in the gateway', 'Notification transports: email, webhook and Slack-compatible', 'Rule storage, which means the Postgres migration']}
    />
  )
}
