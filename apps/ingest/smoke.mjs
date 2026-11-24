// End-to-end smoke test: real client -> real gateway -> fake Loki.
// Proves the ingest path works, the usage counter moves, and live tail delivers.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { rmSync, mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createLogger } from '../../packages/client/dist/index.mjs'

const DB = './data/smoke.db'
const LOKI_PORT = 13100
const GW_PORT = 18080
const SECRET = 'smoke-console-secret'

const received = []
const loki = createServer((req, res) => {
  if (req.url === '/loki/api/v1/push' && req.method === 'POST') {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString()))
      res.writeHead(204).end()
    })
    return
  }
  res.writeHead(404).end()
})

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, label, timeout = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await fn()) return
    await wait(50)
  }
  throw new Error('timed out waiting for ' + label)
}

let gw
try {
  rmSync(DB, { force: true })
  rmSync(DB + '-wal', { force: true })
  rmSync(DB + '-shm', { force: true })
} catch {}
mkdirSync('./data', { recursive: true })

await new Promise((r) => loki.listen(LOKI_PORT, r))
console.log('fake loki on', LOKI_PORT)

// Mint a key through the real seed CLI.
const seed = spawn('node', ['--experimental-strip-types', 'src/seed.ts', 'key', 'smoke', 'public-api', 'test'], {
  env: { ...process.env, LOGGUBER_DB: DB },
  stdio: ['ignore', 'pipe', 'inherit'],
})
let seedOut = ''
seed.stdout.on('data', (c) => (seedOut += c))
await new Promise((r) => seed.on('exit', r))
const apiKey = /lgb_[\w-]+_[\w-]+/.exec(seedOut)?.[0]
if (!apiKey) throw new Error('no key minted: ' + seedOut)
console.log('key minted')

gw = spawn('node', ['--experimental-strip-types', 'src/server.ts'], {
  env: { ...process.env, LOGGUBER_DB: DB, PORT: String(GW_PORT), LOKI_URL: 'http://127.0.0.1:' + LOKI_PORT, CONSOLE_SECRET: SECRET },
  stdio: ['ignore', 'pipe', 'pipe'],
})
gw.stdout.on('data', (c) => process.stdout.write('[gw] ' + c))
gw.stderr.on('data', (c) => {
  const t = String(c)
  if (!/MODULE_TYPELESS|Reparsing|eliminate this warning|trace-warnings/.test(t)) process.stderr.write('[gw!] ' + t)
})
await until(async () => {
  try {
    const r = await fetch('http://127.0.0.1:' + GW_PORT + '/health')
    return r.ok
  } catch {
    return false
  }
}, 'gateway health')
console.log('gateway up')

// Subscribe to live tail before logging, so we can prove fan-out is immediate.
const liveSeen = []
const liveRes = await fetch('http://127.0.0.1:' + GW_PORT + '/internal/live?secret=' + SECRET)
const reader = liveRes.body.getReader()
void (async () => {
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    for (const chunk of buf.split('\n\n')) {
      if (chunk.startsWith('data: ')) {
        try { liveSeen.push(JSON.parse(chunk.slice(6))) } catch {}
      }
    }
    buf = buf.slice(buf.lastIndexOf('\n\n') + 2)
  }
})()

const log = createLogger({
  url: 'ws://127.0.0.1:' + GW_PORT + '/v1/stream',
  apiKey,
  service: 'public-api',
  env: 'test',
  spool: { dir: './data/smoke-spool' },
  onError: (e) => console.error('client onError:', e.message),
})

// `log.info` deliberately strips `kind`, so a usage line cannot be minted by accident.
// Only `log.log()` honours it — which is what the Express middleware uses.
log.log('info', 'GET /v1/users 200', {
  kind: 'request',
  dims: { company_id: 'acme', user_id: 'u_123' },
  meta: { http: { method: 'GET', route: '/v1/users', status: 200, duration_ms: 42 } },
})
log.error('payment failed', { dims: { company_id: 'acme', user_id: 'u_123' } })
await log.flush()

await until(() => received.length > 0, 'loki push')
await until(() => liveSeen.length >= 2, 'live tail delivery')

const streams = received.flatMap((r) => r.streams)
const labels = streams.map((s) => s.stream)
const lines = streams.flatMap((s) => s.values)

console.log('\n--- results ---')
console.log('loki streams:', JSON.stringify(labels))
console.log('first line:', lines[0][1])
console.log('structured metadata:', JSON.stringify(lines[0][2]))
console.log('live tail delivered:', liveSeen.length, 'entries')

const db = new DatabaseSync(DB, { readOnly: true })
const rows = db.prepare('SELECT depth, dims, lines, requests, errors FROM usage_rollup ORDER BY depth').all()
console.log('usage rollup rows:')
for (const r of rows) console.log('  depth=' + r.depth, r.dims, 'lines=' + r.lines, 'requests=' + r.requests, 'errors=' + r.errors)
db.close()

// Checks
const cleanup = () => { try { gw?.kill('SIGKILL') } catch {} ; try { loki.close() } catch {} }
process.on('exit', cleanup)

const problems = []
if (!labels.some((l) => l.service === 'public-api' && l.env === 'test')) problems.push('labels missing service/env')
if (labels.some((l) => 'company_id' in l)) problems.push('company_id leaked into Loki labels (cardinality!)')
if (!lines[0][2].company_id) problems.push('company_id missing from structured metadata')
if (rows.length !== 3) problems.push('expected 3 prefix depths, got ' + rows.length)
const d3 = rows.find((r) => r.depth === 3)
if (!d3 || d3.lines !== 2) problems.push('depth-3 rollup should have 2 lines')
if (d3 && d3.requests !== 1) problems.push('depth-3 rollup should have 1 request')
if (d3 && d3.errors !== 1) problems.push('depth-3 rollup should have 1 error')

await log.close()
reader.cancel().catch(() => {})
cleanup()

if (problems.length) {
  console.error('\nFAIL:\n - ' + problems.join('\n - '))
  process.exit(1)
}
console.log('\nPASS: ingest path, labels, structured metadata, usage rollups and live tail all work')
process.exit(0)
