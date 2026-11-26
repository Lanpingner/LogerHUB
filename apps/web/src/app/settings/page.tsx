import { redirect } from 'next/navigation'
import { currentOperator } from '../../lib/auth'
import { labels, settings } from '../../lib/store'
import { Settings } from '../../components/Management'

export default async function SettingsPage() {
  if (!(await currentOperator())) redirect('/login')
  const cfg = settings()
  return (
    <Settings
      levels={cfg.levels}
      allowlist={cfg.globalIpAllowlist}
      names={labels()}
    />
  )
}
