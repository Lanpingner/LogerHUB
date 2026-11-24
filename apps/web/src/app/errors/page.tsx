import { redirect } from 'next/navigation'
import { currentOperator } from '../../lib/auth'
import { ErrorIntelligence } from '../../components/Intelligence'

export default async function ErrorsPage() {
  if (!(await currentOperator())) redirect('/login')
  return <ErrorIntelligence />
}
