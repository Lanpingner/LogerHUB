import { redirect } from 'next/navigation'
import { currentOperator } from '../../lib/auth'
import { Traffic } from '../../components/Traffic'

export default async function Page() {
  if (!(await currentOperator())) redirect('/login')
  return <Traffic />
}
