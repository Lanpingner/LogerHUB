import { redirect } from 'next/navigation'
import { currentOperator } from '../../lib/auth'
import { SavedQueries } from '../../components/Management'

export default async function QueriesPage() {
  if (!(await currentOperator())) redirect('/login')
  return <SavedQueries />
}
