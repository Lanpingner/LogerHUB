import { redirect } from 'next/navigation'
import { currentOperator } from '../../lib/auth'
import { keys, knownServices } from '../../lib/store'
import { ApiKeys } from '../../components/Management'

export default async function KeysPage() {
  if (!(await currentOperator())) redirect('/login')
  return <ApiKeys keys={keys()} knownServices={knownServices()} />
}
