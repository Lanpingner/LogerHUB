import { redirect } from 'next/navigation'
import { currentOperator } from '../../lib/auth'
import { NotBuilt } from '../../components/NotBuilt'

export default async function Page() {
  if (!(await currentOperator())) redirect('/login')
  return (
    <NotBuilt
      title="Users & Permissions"
      purpose="Operators, roles and what each may see, enforced in the backend rather than in the interface."
      needs={['More than one operator account — the gateway seeds exactly one today', 'Role checks on every query endpoint, not in the console', 'Organisation scoping so a tenant cannot read another tenant']}
    />
  )
}
