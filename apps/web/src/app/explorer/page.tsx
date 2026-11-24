import { redirect } from 'next/navigation'
import { currentOperator } from '../../lib/auth'
import { LogExplorer } from '../../components/LogExplorer'

export default async function ExplorerPage() {
  if (!(await currentOperator())) redirect('/login')
  return <LogExplorer />
}
