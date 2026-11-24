// Setup:  pnpm --filter @leviathan.systems/logerhub-client build   (from the repo root, once)
//         npm install                             (in this directory; the client is a file: dependency)
//         npm start
//
// One logging mechanism: every line below is printed locally AND streamed to the gateway.
// With no gateway reachable the example spools to disk (./.logerhub-spool/spool.db) instead of
// delivering — that is the outage path working: you will see one "connect ECONNREFUSED" warning,
// requests still succeed, and the batches are kept until a gateway accepts them.
import express from 'express'
import { WebSocketServer } from 'ws'
import { createLogger } from '@leviathan.systems/logerhub-client'

const log = createLogger({
  url: process.env.LOGERHUB_URL ?? 'ws://localhost:8080/v1/stream',
  apiKey: process.env.LOGERHUB_KEY ?? 'dev-key',
  service: 'example-app',
  env: process.env.NODE_ENV ?? 'development',
  spool: { dir: process.env.SPOOL_DIR ?? './.logerhub-spool' },
  // Local terminal output, so this replaces a local-only logger outright.
  console: {
    enabled: true,
    pending: true,                       // in-flight requests redraw at the bottom (TTY only)
    file: process.env.LOG_FILE,          // optional: also append the uncoloured line
  },
})

const app = express()
app.use(express.json())

app.use(log.expressMiddleware({
  pending: true,
  captureIp: true,
  // A stand-in for real auth: send  x-fake-auth: company:user:key
  resolveDims: (req) => {
    const [company_id, user_id, api_key_id] = String(req.headers['x-fake-auth'] ?? '').split(':')
    return { company_id, user_id, api_key_id }
  },
  // Decorates the console line, and is stored as metadata either way.
  resolveMeta: (req, res) => ({
    auth: res.authType ? { type: res.authType, cached: Boolean(res.authCached) } : undefined,
    tags: { app: req.headers['x-app'] || undefined },
  }),
  note: (_req, res) => res.authReason,
  ignore: (req) => req.path === '/metrics',
}))

app.get('/ok', (_req, res) => {
  log.info('doing some work')
  res.authType = 'P'
  res.authCached = true
  res.json({ ok: true })
})

app.get('/slow', async (_req, res) => {
  await new Promise((r) => setTimeout(r, 500))   // long enough to watch the in-flight line tick
  res.json({ ok: true })
})

app.post('/fail', (req, res) => {
  // Extra arguments are joined into the message, and an Error keeps its stack.
  log.error('could not finish the order:', new Error('upstream refused'))
  res.authType = 'A'
  res.authReason = 'expired key'
  res.status(500).json({ error: 'something broke' })   // 5xx: the request body is captured, redacted
})

app.get('/metrics', (_req, res) => res.send('not logged'))

const server = app.listen(Number(process.env.PORT ?? 3000), () => {
  log.printLine('── example app listening ──')   // printed locally, not streamed
  log.info('example app listening')
})

// WebSocket traffic through the same logger.
const wss = new WebSocketServer({ server, path: '/ws' })
log.instrumentWs(wss, { messages: 'payload', captureIp: true, pending: true })
wss.on('connection', (socket) => {
  socket.on('message', (data) => socket.send(`echo:${data}`))
})

process.on('SIGTERM', async () => {
  server.close()
  await log.close()   // drains, then restores the terminal
  process.exit(0)
})
