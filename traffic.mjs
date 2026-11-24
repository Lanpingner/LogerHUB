// Simulates traffic from the four services so the console has something real in it.
// Keeps running until you stop it, so Live tail has a pulse.
import { readFileSync } from 'node:fs'
import { createLogger } from './packages/client/dist/index.mjs'

const GW = process.env.GW ?? 'ws://localhost:8090/v1/stream'

const SERVICES = ['office-api', 'public-api', 'chat-api', 'chat-ws']
const COMPANIES = [
  { id: 'acme', users: ['u_101', 'u_102', 'u_103'], weight: 5 },
  { id: 'globex', users: ['u_201', 'u_202'], weight: 3 },
  { id: 'initech', users: ['u_301'], weight: 2 },
  { id: 'umbrella', users: ['u_401', 'u_402'], weight: 1 },
]
const ROUTES = {
  'office-api': ['/v1/invoices', '/v1/invoices/:id', '/v1/staff', '/v1/reports/monthly'],
  'public-api': ['/v1/users', '/v1/users/:id', '/v1/properties', '/v1/search'],
  'chat-api': ['/v1/threads', '/v1/threads/:id/messages', '/v1/presence'],
  'chat-ws': ['/v1/socket', '/v1/socket/resume'],
}

const pick = (a) => a[Math.floor(Math.random() * a.length)]
const weighted = () => {
  const pool = COMPANIES.flatMap((c) => Array(c.weight).fill(c))
  return pick(pool)
}

const loggers = {}
for (const service of SERVICES) {
  const key = readFileSync('/tmp/key-' + service + '.txt', 'utf8').trim()
  loggers[service] = createLogger({
    url: GW,
    apiKey: key,
    service,
    env: 'prod',
    spool: { dir: './apps/ingest/data/traffic-spool-' + service },
    onError: (e) => console.log('[' + service + '] ' + e.message),
  })
}

let sent = 0

function oneRequest(service) {
  const log = loggers[service]
  const company = weighted()
  const user = pick(company.users)
  const route = pick(ROUTES[service])
  const dims = { company_id: company.id, user_id: user, api_key_id: 'k_' + company.id }

  // Mostly successes, a sprinkle of client and server errors.
  const roll = Math.random()
  const status = roll < 0.9 ? 200 : roll < 0.96 ? 404 : roll < 0.99 ? 422 : 500
  const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'
  const duration = Math.round(5 + Math.random() * (status >= 500 ? 900 : 180))

  log.log(level, pick(['GET', 'POST']) + ' ' + route + ' ' + status, {
    kind: 'request',
    dims,
    meta: {
      http: {
        method: 'GET',
        route,
        path: route.replace(':id', String(100 + Math.floor(Math.random() * 900))),
        status,
        duration_ms: duration,
        request_id: Math.random().toString(36).slice(2, 10),
        req: { headers: { 'content-type': 'application/json', 'user-agent': 'acme-client/2.1' } },
        ...(status >= 400
          ? { res: { body: { error: status === 500 ? 'upstream timeout' : 'validation failed', field: 'email' } } }
          : {}),
      },
    },
  })
  sent++

  // Some ordinary application logs alongside the request lines.
  if (Math.random() < 0.15) {
    log.info(pick(['cache warmed', 'webhook queued', 'session refreshed', 'rate limit near']), { dims })
    sent++
  }
  if (status >= 500) {
    log.error('unhandled upstream failure', {
      dims,
      meta: { err: { name: 'TimeoutError', message: 'upstream did not respond in 900ms' } },
    })
    sent++
  }
}

// A burst of history first, so Usage and Search are not empty.
for (let i = 0; i < 400; i++) oneRequest(pick(SERVICES))
await Promise.all(Object.values(loggers).map((l) => l.flush()))
console.log('seeded ' + sent + ' lines of history')

// Then a steady trickle, so Live tail shows movement.
const tick = setInterval(() => {
  const n = 1 + Math.floor(Math.random() * 3)
  for (let i = 0; i < n; i++) oneRequest(pick(SERVICES))
}, 900)

let stopping = false
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (stopping) return
    stopping = true
    clearInterval(tick)
    console.log('\nflushing ' + sent + ' lines total…')
    Promise.all(Object.values(loggers).map((l) => l.close())).then(() => process.exit(0))
    setTimeout(() => process.exit(0), 4000)
  })
}
