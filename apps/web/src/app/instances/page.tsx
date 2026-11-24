import { redirect } from 'next/navigation'
import { currentOperator } from '../../lib/auth'
import { NotBuilt } from '../../components/NotBuilt'

export default async function Page() {
  if (!(await currentOperator())) redirect('/login')
  return (
    <NotBuilt
      title="Instances"
      purpose="Which hosts or containers are reporting, when each last sent, and which have gone quiet."
      needs={['An instance identifier on every line, which the SDK does not set yet', 'A last-seen table so a silent instance is detectable']}
    />
  )
}
