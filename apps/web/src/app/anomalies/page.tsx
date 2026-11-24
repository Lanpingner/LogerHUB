import { redirect } from 'next/navigation'
import { currentOperator } from '../../lib/auth'
import { NotBuilt } from '../../components/NotBuilt'

export default async function Page() {
  if (!(await currentOperator())) redirect('/login')
  return (
    <NotBuilt
      title="Anomalies"
      purpose="Unusual traffic or error patterns surfaced automatically, rather than found by staring at charts."
      needs={['A baseline per endpoint and client, stored over weeks', 'A scoring job that runs on a schedule', 'Somewhere to record what was already dismissed']}
    />
  )
}
