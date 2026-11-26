import { redirect } from 'next/navigation'
import { currentOperator } from '../../lib/auth'
import { Services } from '../../components/Services'

export default async function Page() {
  if (!(await currentOperator())) redirect('/login')
  return <Services />
}
