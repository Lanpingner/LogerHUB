// Starts the whole stack (fake Loki + gateway + console), pushes logs through the
// real client, then fetches every console page over HTTP and checks what rendered.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createHmac, scryptSync } from 'node:crypto'
import { rmSync, mkdirSync, existsSync, cpSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { resolve } from 'node:path'
import { createLogger } from './packages/client/dist/index.mjs'

/** A port the OS says is free right now. Hardcoded ports made this harness
 *  unrunnable whenever an earlier run left a server behind — and worse, an
 *  orphan on the console's port once made every check pass against a build
 *  from the day before. */
const freePort = () =>
  new Promise((ok, fail) => {
    const s = createNetServer()
    s.once('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => ok(port))
    })
  })

const LOKI_PORT = await freePort()
const GW_PORT = await freePort()
const WEB_PORT = await freePort()
const DB = './apps/ingest/data/verify.db'
/** The standalone server runs with its own working directory, so a relative
 *  database path would resolve somewhere else entirely. */
const DB_ABS = resolve(DB)
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
  // Instant metric queries, as `sum by (<labels>) (count_over_time(...))`.
  // Computed from the pushed streams rather than canned, so the Environments
  // page is checked against numbers that follow from the logs this harness sent.
  if (req.url?.startsWith('/loki/api/v1/query?')) {
    const query = decodeURIComponent(new URL(req.url, 'http://x').searchParams.get('query') ?? '')
    const by = (/by \(([^)]*)\)/.exec(query)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const errorsOnly = /level=~"error\|fatal"/.test(query)
    const counts = new Map()
    for (const p of pushed) {
      for (const st of p.streams) {
        if (errorsOnly && !['error', 'fatal'].includes(st.stream.level)) continue
        const metric = {}
        for (const l of by) metric[l] = st.stream[l] ?? ''
        const key = JSON.stringify(metric)
        counts.set(key, (counts.get(key) ?? 0) + st.values.length)
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      status: 'success',
      data: {
        resultType: 'vector',
        result: [...counts].map(([k, n]) => ({ metric: JSON.parse(k), value: [Date.now() / 1000, String(n)] })),
      },
    }))
    return
  }
  const label = /^\/loki\/api\/v1\/label\/([^/]+)\/values/.exec(req.url ?? '')
  if (label) {
    const seen = new Set()
    for (const p of pushed) for (const st of p.streams) {
      const v = st.stream[label[1]]
      if (v) seen.add(v)
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'success', data: [...seen].sort() }))
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
async function seed(args, stdinText) {
  const c = spawn('node', ['--experimental-strip-types', 'src/seed.ts', ...args], {
    cwd: 'apps/ingest',
    env: { ...process.env, LOGGUBER_DB: '../../' + DB },
    stdio: [stdinText == null ? 'ignore' : 'pipe', 'pipe', 'inherit'],
  })
  let out = ''
  c.stdout.on('data', (b) => (out += b))
  if (stdinText != null) c.stdin.end(stdinText + '\n')
  const code = await new Promise((r) => c.on('exit', r))
  if (code !== 0) throw new Error('seed ' + args[0] + ' failed with code ' + code)
  return out
}
// The CLI refuses a password in argv, so it goes down stdin the way an operator
// would pipe it.
await seed(['operator', EMAIL], PASSWORD)
const keyOut = await seed(['key', 'public-api', 'public-api,office-api', 'prod'])
const apiKey = /lgb_[\w-]+_[\w-]+/.exec(keyOut)?.[0]
if (!apiKey) throw new Error('no api key minted')
console.log('seeded operator and key')

// --- gateway and console --------------------------------------------------
run('node', ['--experimental-strip-types', 'apps/ingest/src/server.ts'], {
  PORT: String(GW_PORT), LOGGUBER_DB: DB, LOKI_URL: 'http://127.0.0.1:' + LOKI_PORT, CONSOLE_SECRET,
}, 'gw')

// `next start` refuses an `output: 'standalone'` build, which is what this
// project ships, so the harness runs the same server the container runs:
// apps/web/server.js from the standalone tree, with the static assets placed
// beside it exactly as deploy/web.Dockerfile does.
const STANDALONE = 'apps/web/.next/standalone'
// Always, unless asked not to. Building only when the output was missing meant
// the harness happily tested a build from before the change under test — it
// reported the old success rate for a commit that had already replaced it.
// Reusing a stale build is the same failure as hitting a stale server, and both
// end with a green run that proves nothing.
if (process.env.VERIFY_SKIP_BUILD === '1') {
  if (!existsSync(STANDALONE + '/apps/web/server.js')) throw new Error('VERIFY_SKIP_BUILD=1 but there is no build')
  console.log('reusing the existing build (VERIFY_SKIP_BUILD=1) — it may not include your changes')
} else {
  console.log('building the console')
  const build = spawn('npm', ['run', 'build', '--workspace', '@logguber/web'], { stdio: 'inherit' })
  const code = await new Promise((r) => build.on('exit', r))
  if (code !== 0) throw new Error('next build failed with code ' + code)
}
// Without this every /_next/static request 404s: the static assets are
// deliberately not part of the standalone output.
cpSync('apps/web/.next/static', STANDALONE + '/apps/web/.next/static', { recursive: true })

run('node', ['apps/web/server.js'], {
  LOGGUBER_DB: DB_ABS,
  LOKI_URL: 'http://127.0.0.1:' + LOKI_PORT,
  INGEST_INTERNAL_URL: 'http://127.0.0.1:' + GW_PORT,
  CONSOLE_SECRET, SESSION_SECRET, NODE_ENV: 'production',
  PORT: String(WEB_PORT), HOSTNAME: '127.0.0.1',
}, 'web', STANDALONE)

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
// Deliberately at info level with failing statuses. The usage counters must
// classify these from the status, which the old level-based proxy could not: it
// would have called both of them successes.
log.log('info', 'GET /v1/users 404', {
  kind: 'request', dims: { company_id: 'acme', user_id: 'u_1' },
  meta: { http: { method: 'GET', route: '/v1/users', status: 404, duration_ms: 3 } },
})
log.log('info', 'GET /v1/users 500', {
  kind: 'request', dims: { company_id: 'acme', user_id: 'u_1' },
  meta: { http: { method: 'GET', route: '/v1/users', status: 500, duration_ms: 9 } },
})
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

// The forged cookie above skips the password check. The login page posts a
// server action, which a plain fetch cannot drive, so verify the part that
// actually changed: the console must accept the hash the seed CLI writes. A
// mismatch there locks the operator out of their own console.
{
  const { verifyPassword } = await import('./apps/web/src/lib/password.ts')
  const row = new DatabaseSync(DB, { readOnly: true })
    .prepare('SELECT password_hash FROM operators WHERE email = ?')
    .get(EMAIL)
  const hash = String(row?.password_hash ?? '')
  const shape = /^scrypt\$\d+:\d+:\d+\$[0-9a-f]+\$[0-9a-f]+$/.test(hash)
  const accepts = hash ? verifyPassword(PASSWORD, hash) : false
  const rejects = hash ? !verifyPassword(PASSWORD + 'x', hash) : false
  checks.push({ path: 'seeded hash records its scrypt cost', status: 200, ok: shape, missing: shape ? [] : ['got ' + hash.slice(0, 24)] })
  checks.push({ path: 'console accepts the seeded password', status: 200, ok: accepts, missing: accepts ? [] : ['verifyPassword said no'] })
  checks.push({ path: 'console rejects a wrong password', status: 200, ok: rejects, missing: rejects ? [] : ['verifyPassword said yes'] })
  // The older two-part shape must keep working, or raising the cost would lock
  // out every operator created before the change.
  const legacySalt = 'abc123'
  const legacy = 'scrypt$' + legacySalt + '$' + scryptSync(PASSWORD, legacySalt, 64).toString('hex')
  const legacyOk = verifyPassword(PASSWORD, legacy) && !verifyPassword('nope', legacy)
  checks.push({ path: 'console still accepts a pre-change hash', status: 200, ok: legacyOk, missing: legacyOk ? [] : ['legacy hash rejected'] })
}

async function page(path, mustContain) {
  const res = await fetch('http://127.0.0.1:' + WEB_PORT + path, { headers: { cookie }, redirect: 'manual' })
  const html = await res.text()
  const missing = mustContain.filter((t) => !html.includes(t))
  checks.push({ path, status: res.status, ok: res.status === 200 && missing.length === 0, missing })
  return html
}

// Every data panel in this console is a client component that fetches after
// hydration, so the server-rendered HTML carries chrome and no data. Asserting
// log content against HTML only worked while `/` was a server-rendered search
// page. Pages are checked for rendering; the data they will fetch is checked
// against the APIs they fetch it from, which is the stronger assertion anyway.
await page('/', ['Overview'])
await page('/explorer', ['Log Explorer'])
await page('/live', ['Live Console'])
await page('/endpoints', ['API Endpoints'])
await page('/mcp', ['MCP Tools'])
await page('/environments', ['Environments'])
await page('/applications', ['Applications', 'public-api'])
await page('/keys', ['public-api'])
await page('/settings', ['Settings'])

async function api(path, check) {
  const res = await fetch('http://127.0.0.1:' + WEB_PORT + path, { headers: { cookie } })
  let body = null
  try { body = await res.json() } catch {}
  const missing = res.ok && body ? check(body) : ['status ' + res.status]
  checks.push({ path, status: res.status, ok: res.status === 200 && missing.length === 0, missing })
}

// The lines this harness pushed must come back out through the search API.
await api('/api/search?range=24h&limit=500&q=', (b) => {
  const msgs = (b.rows ?? []).map((r) => r.msg).join(' | ')
  const want = ['GET /v1/users 200', 'card declined']
  const missing = want.filter((t) => !msgs.includes(t))
  const dims = (b.rows ?? []).some((r) => r.company === 'acme' && r.user === 'u_1')
  if (!dims) missing.push('a row carrying company acme / user u_1')
  return missing
})

// Exact per-environment counts, straight from Loki rather than a sample.
await api('/api/environments?range=24h', (b) => {
  const prod = (b.rows ?? []).find((r) => r.env === 'prod')
  if (!prod) return ['no prod environment']
  const missing = []
  // 12 lines went in: 11 requests and one error-level line.
  if (prod.lines !== 12) missing.push('prod lines=' + prod.lines + ', wanted 12')
  if (prod.errors !== 1) missing.push('prod errors=' + prod.errors + ', wanted 1')
  if (!prod.services.some((s) => s.service === 'public-api')) missing.push('public-api not listed under prod')
  return missing
})

// Success and error rates must come from HTTP status, not from log level. Of
// the 11 requests pushed, one is a 404 and one a 500, and BOTH were logged at
// info — so a level-based rate would report no failures at all.
await api('/api/overview?range=24h', (b) => {
  const missing = []
  if (b.classified !== 11) missing.push('classified=' + b.classified + ', wanted 11')
  if (Math.abs((b.successRate ?? 0) - 9 / 11) > 0.001) missing.push('successRate=' + b.successRate + ', wanted 9/11')
  if (Math.abs((b.clientErrorRate ?? 0) - 1 / 11) > 0.001) missing.push('clientErrorRate=' + b.clientErrorRate)
  if (Math.abs((b.serverErrorRate ?? 0) - 1 / 11) > 0.001) missing.push('serverErrorRate=' + b.serverErrorRate)
  // The level-based counter still sees exactly one error, which is what makes
  // the point: these are two different measurements of two different things.
  if (b.errors !== 1) missing.push('errors=' + b.errors + ', wanted 1')
  return missing
})

// An unauthenticated request must be redirected with a real status and must
// carry no console data. The status is asserted now that src/proxy.ts decides
// this before rendering starts; it used to arrive as a meta refresh inside a
// 200, because the root loading boundary flushes the shell before the page's
// own redirect runs.
{
  const res = await fetch('http://127.0.0.1:' + WEB_PORT + '/', { redirect: 'manual' })
  const html = res.status === 200 ? await res.text() : ''
  const redirected = res.status >= 300 && res.status < 400
  // Strings that only appear once a panel has real data in it.
  const leaked = ['GET /v1/users 200', 'card declined', 'acme', 'globex'].filter((t) => html.includes(t))
  const missing = []
  if (!redirected) missing.push('not redirected, status ' + res.status)
  if (redirected && !(res.headers.get('location') ?? '').includes('/login')) {
    missing.push('redirected to ' + res.headers.get('location'))
  }
  if (leaked.length) missing.push('leaked: ' + leaked.join(', '))
  checks.push({ path: '/ (no cookie)', status: res.status, ok: missing.length === 0, missing })
}

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
console.log('\nPASS: gateway, client, Loki push, explorer, environments, live and settings all work together')
process.exit(0)
