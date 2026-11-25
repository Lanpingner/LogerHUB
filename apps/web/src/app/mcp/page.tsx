import { redirect } from 'next/navigation'
import { currentOperator } from '../../lib/auth'
import { McpTools } from '../../components/McpTools'

export default async function McpPage() {
  if (!(await currentOperator())) redirect('/login')
  return <McpTools />
}
