import { redirect } from 'next/navigation'
import { currentOperator } from '../../lib/auth'
import { NotBuilt } from '../../components/NotBuilt'

export default async function Page() {
  if (!(await currentOperator())) redirect('/login')
  return (
    <NotBuilt
      title="Incidents"
      purpose="An incident timeline with acknowledgement, assignment, resolution notes and the queries that found it."
      needs={['Alert rules to open incidents from', 'Mutable state per incident, which means the Postgres migration', 'An audit trail of who changed what']}
    />
  )
}
