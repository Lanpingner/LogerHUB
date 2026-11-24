import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { currentOperator } from '../../lib/auth'
import { disableKey, keys, labels, putLabel, recentErrors, saveSettings, settings } from '../../lib/store'

/** Server actions are independently addressable POST endpoints: the page's own
 *  auth check does not protect them, so every action re-verifies the session. */
async function requireOperator() {
  const operator = await currentOperator()
  if (!operator) throw new Error('unauthorised')
  return operator
}

const INGEST_URL = (process.env.INGEST_INTERNAL_URL ?? 'http://localhost:8080').replace(/\/$/, '')
const CONSOLE_SECRET = process.env.CONSOLE_SECRET ?? ''

/** A revoked key must also lose its open sockets, not merely fail its next handshake. */
async function notifyGateway(): Promise<void> {
  if (!CONSOLE_SECRET) return
  try {
    await fetch(INGEST_URL + '/internal/reload', {
      method: 'POST',
      headers: { 'x-console-secret': CONSOLE_SECRET },
      cache: 'no-store',
    })
  } catch {
    // The gateway also polls the config version, so a missed call costs seconds, not correctness.
  }
}

function when(ms: number | null): string {
  if (!ms) return 'never'
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago'
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago'
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}

export default async function AdminPage() {
  if (!(await currentOperator())) redirect('/login')

  const cfg = settings()
  const allKeys = keys()
  const names = labels()
  const errors = recentErrors()

  async function revoke(form: FormData) {
    'use server'
    await requireOperator()
    disableKey(String(form.get('id') ?? ''))
    await notifyGateway()
    revalidatePath('/admin')
  }

  async function saveHierarchy(form: FormData) {
    'use server'
    await requireOperator()
    const raw = String(form.get('levels') ?? '')
    const levels = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [key, ...rest] = line.split(/[:,]/)
        return { key: key.trim(), label: (rest.join(':').trim() || key.trim()) }
      })
      .filter((l) => l.key)
    if (!levels.length) return
    const current = settings()
    saveSettings({
      levels,
      globalIpAllowlist: current.globalIpAllowlist,
      retentionDays: current.retentionDays,
    })
    await notifyGateway()
    revalidatePath('/admin')
  }

  async function saveOps(form: FormData) {
    'use server'
    await requireOperator()
    const current = settings()
    const allowlist = String(form.get('allowlist') ?? '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    const days = Number(form.get('retention'))
    saveSettings({
      levels: current.levels,
      globalIpAllowlist: allowlist,
      retentionDays: Number.isFinite(days) && days > 0 ? days : current.retentionDays,
    })
    await notifyGateway()
    revalidatePath('/admin')
  }

  async function nameValue(form: FormData) {
    'use server'
    await requireOperator()
    const key = String(form.get('dim_key') ?? '')
    const value = String(form.get('dim_value') ?? '')
    const display = String(form.get('display') ?? '')
    if (key && value && display) putLabel(key, value, display)
    revalidatePath('/admin')
  }

  return (
    <>
      <h1>Admin</h1>

      <h2>API keys</h2>
      <p className="hint">
        Each service gets its own key, scoped to the services and environments it may write. A compromised host can
        therefore only forge its own logs. Create keys with the gateway CLI —{' '}
        <code>pnpm --filter @logguber/ingest seed key &lt;name&gt; &lt;services&gt; [envs]</code> — which prints the
        secret once and stores only its hash.
      </p>
      <div className="panel" style={{ padding: 0, overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Key id</th>
              <th>Services</th>
              <th>Envs</th>
              <th>IP allowlist</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {allKeys.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ color: 'var(--muted)' }}>
                  No keys yet.
                </td>
              </tr>
            ) : (
              allKeys.map((k) => (
                <tr key={k.id} style={k.disabled_at ? { opacity: 0.5 } : undefined}>
                  <td>{k.name}</td>
                  <td className="mono">{k.key_id}</td>
                  <td className="mono">{k.service_scope.join(', ') || '—'}</td>
                  <td className="mono">{k.env_scope?.join(', ') ?? 'any'}</td>
                  <td className="mono">{k.ip_allowlist.join(', ') || 'global'}</td>
                  <td>
                    {when(k.last_used_at)}
                    {k.last_used_ip ? (
                      <span className="mono" style={{ color: 'var(--muted)' }}>
                        {' '}
                        {k.last_used_ip}
                      </span>
                    ) : null}
                  </td>
                  <td>
                    {k.disabled_at ? (
                      <span style={{ color: 'var(--muted)' }}>revoked</span>
                    ) : (
                      <form action={revoke}>
                        <input type="hidden" name="id" value={k.id} />
                        <button className="danger" type="submit">
                          Revoke
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <h2>Drill-down hierarchy</h2>
      <p className="hint">
        One level per line, as <code>key: Label</code>. This drives the Usage drill-down and the search filters. Adding
        a level starts recording at that depth from now on; older data shows <code>unknown</code> there. Only{' '}
        <code>service</code> is a Loki label — everything else is matched as structured metadata, which is why adding
        levels is cheap.
      </p>
      <form action={saveHierarchy} className="panel" style={{ display: 'grid', gap: 10, maxWidth: 520 }}>
        <textarea
          name="levels"
          rows={Math.max(3, cfg.levels.length + 1)}
          className="mono"
          defaultValue={cfg.levels.map((l) => l.key + ': ' + l.label).join('\n')}
        />
        <button className="primary" type="submit" style={{ justifySelf: 'start' }}>
          Save hierarchy
        </button>
      </form>

      <h2>Access and retention</h2>
      <form action={saveOps} className="panel" style={{ display: 'grid', gap: 12, maxWidth: 520 }}>
        <div className="field">
          <label htmlFor="allowlist">Global IP allowlist (CIDR, comma or space separated)</label>
          <input
            id="allowlist"
            name="allowlist"
            className="mono"
            placeholder="203.0.113.4/32 10.0.0.0/8"
            defaultValue={cfg.globalIpAllowlist.join(' ')}
          />
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            Empty means any IP may connect. A key with its own allowlist ignores this one.
          </span>
        </div>
        <div className="field">
          <label htmlFor="retention">Log retention (days)</label>
          <input id="retention" name="retention" type="number" min={1} defaultValue={cfg.retentionDays} style={{ width: 120 }} />
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            Applies to raw logs in Loki. Usage counters are kept indefinitely — they are tiny.
          </span>
        </div>
        <button className="primary" type="submit" style={{ justifySelf: 'start' }}>
          Save
        </button>
      </form>

      <h2>Display names</h2>
      <p className="hint">
        Optional, purely cosmetic: map an id to a readable name so charts show “Acme Ltd” instead of{' '}
        <code>acme</code>. Names live here, never in the ingest payload.
      </p>
      <form action={nameValue} className="panel row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <select name="dim_key" defaultValue={cfg.levels[1]?.key ?? 'company_id'}>
          {cfg.levels.map((l) => (
            <option key={l.key} value={l.key}>
              {l.key}
            </option>
          ))}
        </select>
        <input name="dim_value" placeholder="acme" className="mono" size={14} required />
        <span style={{ color: 'var(--muted)' }}>→</span>
        <input name="display" placeholder="Acme Ltd" size={18} required />
        <button type="submit">Add</button>
      </form>
      {Object.keys(names).length ? (
        <div className="chips" style={{ marginTop: 10 }}>
          {Object.entries(names).flatMap(([k, vals]) =>
            Object.entries(vals).map(([v, d]) => (
              <span className="chip mono" key={k + v}>
                {k}:{v} → {d}
              </span>
            )),
          )}
        </div>
      ) : null}

      <h2>Recent ingest problems</h2>
      <p className="hint">
        Rejected batches, refused IPs, and loss your services reported. An empty table is the good case.
      </p>
      <div className="panel" style={{ padding: 0, overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Key</th>
              <th>Reason</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {errors.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ color: 'var(--muted)' }}>
                  Nothing recorded.
                </td>
              </tr>
            ) : (
              errors.map((e, i) => (
                <tr key={i}>
                  <td className="mono">{new Date(e.at).toISOString().slice(0, 19).replace('T', ' ')}</td>
                  <td className="mono">{e.key_id ?? '—'}</td>
                  <td>{e.reason}</td>
                  <td className="mono" style={{ color: 'var(--muted)' }}>
                    {e.detail ?? ''}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
