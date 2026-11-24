import { redirect } from 'next/navigation'
import { currentOperator } from '../../lib/auth'
import { Performance } from '../../components/Intelligence'

export default async function PerformancePage() {
  if (!(await currentOperator())) redirect('/login')
  return <Performance />
}
