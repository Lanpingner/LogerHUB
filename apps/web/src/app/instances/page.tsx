import { redirect } from 'next/navigation'
import { currentOperator } from '../../lib/auth'
import { Instances } from '../../components/Instances'

export default async function Page() {
  if (!(await currentOperator())) redirect('/login')
  return <Instances />
}
