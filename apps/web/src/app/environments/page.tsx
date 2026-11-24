import { redirect } from 'next/navigation'
import { currentOperator } from '../../lib/auth'
import { NotBuilt } from '../../components/NotBuilt'

export default async function Page() {
  if (!(await currentOperator())) redirect('/login')
  return (
    <NotBuilt
      title="Environments"
      purpose="Compare the same application across production, staging and anywhere else it runs."
      needs={['Environment-scoped comparisons in the query layer', 'Per-environment retention settings']}
    />
  )
}
