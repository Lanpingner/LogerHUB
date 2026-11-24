// Starts the whole stack (fake Loki + gateway + console), pushes logs through the
// real client, then fetches every console page over HTTP and checks what rendered.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { rmSync, mkdirSync } from 'node:fs'
import { createLogger } from './packages/client/dist/index.mjs'

const LOKI_PORT = 13101
const GW_PORT = 18081
const WEB_PORT = 13000
const DB = './apps/ingest/data/verify.db'
const CONSOLE_SECRET = 'verify-console-secret'
const SESSION_SECRET = 'verify-session-secret'
const EMAIL = 'ops@example.com'
const PASSWORD = 'correct-horse-battery'

const children = []
const cleanup = () => {
  for (const c of children) { try { c.kill('SIGKILL') } catch {} }
  try { loki.close() } catch {}
}
process.on('exit', cleanup)

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, label, timeout = 60000) {
  const start = Date.now()
  let last
  while (Date.now() - start < timeout) {
    try { if (await fn()) return } catch (e) { last = e }
    await wait(150)
  }
  throw new Error('timed out waiting for ' + label + (last ? ': ' + last.message : ''))
}

function run(cmd, args, env, label, cwd) {
  const c = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(c)
  const show = (prefix) => (chunk) => {
    const t = String(chunk)
    if (/MODULE_TYPELESS|Reparsing|eliminate this warning|trace-warnings|npm notice/.test(t)) return
    process.stdout.write('[' + prefix + '] ' + t)
  }
  c.stdout.on('data', show(label))
  c.stderr.on('data', show(label + '!'))
  return c
}

// --- fake Loki, so this runs without docker -------------------------------
const pushed = []
const loki = createServer((req, res) => {
  if (req.url?.startsWith('/loki/api/v1/push')) {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => { pushed.push(JSON.parse(Buffer.concat(chunks).toString())); res.writeHead(204).end() })
    return
  }
  if (req.url?.startsWith('/loki/api/v1/query_range')) {
    // Serve back what was pushed, so Search has something real to render.
    const result = pushed.flatMap((p) => p.streams)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'success', data: { resultType: 'streams', result } }))
    return
  }
  res.writeHead(404).end()
})

rmSync(DB, { force: true })
rmSync(DB + '-wal', { force: true })
rmSync(DB + '-shm', { force: true })
rmSync('./apps/ingest/data/verify-spool', { recursive: true, force: true })
mkdirSync('./apps/ingest/data', { recursive: true })

await new Promise((r) => loki.listen(LOKI_PORT, r))
console.log('fake loki on ' + LOKI_PORT)

// --- seed an operator and a key through the real CLI ----------------------
async function seed(args) {
  const c = spawn('node', ['--experimental-strip-types', 'src/seed.ts', ...args], {
    cwd: 'apps/ingest',
    env: { ...process.env, LOGGUBER_DB: '../../' + DB },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let out = ''
  c.stdout.on('data', (b) => (out += b))
  await new Promise((r) => c.on('exit', r))
  return out
}
await seed(['operator', EMAIL, PASSWORD])
const keyOut = await seed(['key', 'public-api', 'public-api,office-api', 'prod'])
const apiKey = /lgb_[\w-]+_[\w-]+/.exec(keyOut)?.[0]
if (!apiKey) throw new Error('no api key minted')
console.log('seeded operator and key')

// --- gateway and console --------------------------------------------------
run('node', ['--experimental-strip-types', 'apps/ingest/src/server.ts'], {
  PORT: String(GW_PORT), LOGGUBER_DB: DB, LOKI_URL: 'http://127.0.0.1:' + LOKI_PORT, CONSOLE_SECRET,
}, 'gw')

run('npx', ['next', 'start', '-p', String(WEB_PORT)], {
  LOGGUBER_DB: '../../' + DB,
  LOKI_URL: 'http://127.0.0.1:' + LOKI_PORT,
  INGEST_INTERNAL_URL: 'http://127.0.0.1:' + GW_PORT,
  CONSOLE_SECRET, SESSION_SECRET, NODE_ENV: 'production',
}, 'web', 'apps/web')

await until(async () => (await fetch('http://127.0.0.1:' + GW_PORT + '/health')).ok, 'gateway')
console.log('gateway up')
await until(async () => (await fetch('http://127.0.0.1:' + WEB_PORT + '/login')).ok, 'console')
console.log('console up')

// --- push real logs through the real client -------------------------------
const log = createLogger({
  url: 'ws://127.0.0.1:' + GW_PORT + '/v1/stream',
  apiKey, service: 'public-api', env: 'prod',
  spool: { dir: './apps/ingest/data/verify-spool' },
  onError: (e) => console.log('[client!] ' + e.message),
})
for (const [company, user, n] of [['acme', 'u_1', 6], ['globex', 'u_7', 3]]) {
  for (let i = 0; i < n; i++) {
    log.log('info', 'GET /v1/users 200', {
      kind: 'request',
      dims: { company_id: company, user_id: user, api_key_id: 'k_live' },
      meta: { http: { method: 'GET', route: '/v1/users', status: 200, duration_ms: 20 + i } },
    })
  }
}
log.error('card declined', { dims: { company_id: 'acme', user_id: 'u_1' }, meta: { http: { status: 502 } } })
await log.flush()
await until(() => pushed.length > 0, 'loki push')
console.log('client pushed ' + pushed.flatMap((p) => p.streams).length + ' streams')

// --- log in the way the browser does, then fetch every page ---------------
function sessionCookie(email) {
  const payload = Buffer.from(JSON.stringify({ email, expires: Date.now() + 3600_000 })).toString('base64url')
  return 'logguber_session=' + payload + '.' + createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url')
}
const cookie = sessionCookie(EMAIL)

const checks = []
async function page(path, mustContain) {
  const res = await fetch('http://127.0.0.1:' + WEB_PORT + path, { headers: { cookie }, redirect: 'manual' })
  const html = await res.text()
  const missing = mustContain.filter((t) => !html.includes(t))
  checks.push({ path, status: res.status, ok: res.status === 200 && missing.length === 0, missing })
  return html
}

// React splits adjacent text nodes in SSR output, so assert on the values
// rather than on rendered "key=value" pairs.
await page('/', ['Search', 'GET /v1/users 200', 'company_id', 'acme', 'card declined'])
// The default usage view is the first hierarchy level: service.
await page('/usage', ['Usage', 'public-api', 'Requests', 'Error rate'])
// Drilling into a service shows the companies under it — the operator's main question.
await page('/usage?p_service=public-api', ['acme', 'globex', 'Company'])
// And one more level down: the users inside one company.
await page('/usage?p_service=public-api&p_company_id=acme', ['u_1', 'User'])
await page('/live', ['Live tail', 'Connecting'])
await page('/admin', ['Admin', 'public-api', 'Drill-down hierarchy'])

// An unauthenticated request must not see any of it.
const anon = await fetch('http://127.0.0.1:' + WEB_PORT + '/usage', { redirect: 'manual' })
checks.push({ path: '/usage (no cookie)', status: anon.status, ok: anon.status >= 300 && anon.status < 400, missing: [] })

// The live relay must refuse an unauthenticated caller too.
const anonLive = await fetch('http://127.0.0.1:' + WEB_PORT + '/api/live', { redirect: 'manual' })
checks.push({ path: '/api/live (no cookie)', status: anonLive.status, ok: anonLive.status === 401, missing: [] })

console.log('\n--- console checks ---')
for (const c of checks) {
  console.log((c.ok ? 'PASS' : 'FAIL') + '  ' + c.path + '  [' + c.status + ']' + (c.missing.length ? '  missing: ' + c.missing.join(', ') : ''))
}

await log.close()
cleanup()
const failed = checks.filter((c) => !c.ok)
if (failed.length) {
  console.error('\n' + failed.length + ' check(s) failed')
  process.exit(1)
}
console.log('\nPASS: gateway, client, Loki push, search, usage, live and admin all work together')
process.exit(0)
