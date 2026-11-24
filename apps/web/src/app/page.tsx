import { redirect } from 'next/navigation'
import { currentOperator } from '../lib/auth'
import { Overview } from '../components/Overview'

export default async function OverviewPage() {
  if (!(await currentOperator())) redirect('/login')
  return <Overview />
}
