import { redirect } from 'next/navigation'
import { currentOperator } from '../../lib/auth'
import { NotBuilt } from '../../components/NotBuilt'

export default async function Page() {
  if (!(await currentOperator())) redirect('/login')
  return (
    <NotBuilt
      title="Services"
      purpose="Every service inside each application, with its instances, ingestion statistics and health."
      needs={['A service dimension distinct from application — the SDK sends one service name per logger today', 'Per-instance reporting from the SDK']}
    />
  )
}
