import { redirect } from 'next/navigation'
import { currentOperator } from '../../lib/auth'
import { keys, recentErrors } from '../../lib/store'
import { tree } from '../../lib/server-queries'
import { Applications } from '../../components/Applications'

export default async function ApplicationsPage() {
  if (!(await currentOperator())) redirect('/login')
  return <Applications environments={tree(1440)} keys={keys()} problems={recentErrors()} />
}
