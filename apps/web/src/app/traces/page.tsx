import { redirect } from 'next/navigation'
import { currentOperator } from '../../lib/auth'
import { NotBuilt } from '../../components/NotBuilt'

export default async function Page() {
  if (!(await currentOperator())) redirect('/login')
  return (
    <NotBuilt
      title="Request Traces"
      purpose="Follow one request across every service it touched, as a hierarchical timeline with durations, statuses and parent-child relationships."
      needs={['A trace id on every line — the SDK accepts one as meta.http.trace_id but nothing sets it yet', 'Span start and end times, not just a total duration', 'An index on trace id so pulling one trace does not scan the range']}
    />
  )
}
