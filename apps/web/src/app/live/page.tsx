import { redirect } from 'next/navigation'
import { currentOperator } from '../../lib/auth'
import { LiveConsole } from '../../components/LiveConsole'

export default async function LiveConsolePage() {
  if (!(await currentOperator())) redirect('/login')
  return <LiveConsole />
}
