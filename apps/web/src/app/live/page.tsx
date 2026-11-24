import { redirect } from 'next/navigation'
import { currentOperator } from '../../lib/auth'
import { knownServices, settings } from '../../lib/store'
import { Tail } from './tail'

export default async function LivePage() {
  if (!(await currentOperator())) redirect('/login')
  const cfg = settings()
  return (
    <>
      <h1>Live tail</h1>
      <p className="hint">
        Streamed straight from the gateway as it accepts each line, so there is no storage round trip. Filters are
        applied at the gateway, not in your browser.
      </p>
      <Tail services={knownServices()} dimKeys={cfg.levels.map((l) => l.key).filter((k) => k !== 'service')} />
    </>
  )
}
