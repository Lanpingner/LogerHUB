import { redirect } from 'next/navigation'
import { currentOperator } from '../../lib/auth'
import { Endpoints } from '../../components/LogExplorer'

export default async function EndpointsPage() {
  if (!(await currentOperator())) redirect('/login')
  return <Endpoints />
}
