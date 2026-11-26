import { redirect } from 'next/navigation'
import { currentOperator } from '../../lib/auth'
import { Environments } from '../../components/Environments'

export default async function Page() {
  if (!(await currentOperator())) redirect('/login')
  return <Environments />
}
