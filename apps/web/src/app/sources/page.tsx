import { redirect } from 'next/navigation'
import { currentOperator } from '../../lib/auth'
import { NotBuilt } from '../../components/NotBuilt'

export default async function Page() {
  if (!(await currentOperator())) redirect('/login')
  return (
    <NotBuilt
      title="Data Sources"
      purpose="Where logs are stored and queried from, and the health of each backend."
      needs={['Health checks against Loki and the gateway on a schedule', 'Support for more than one storage backend']}
    />
  )
}
