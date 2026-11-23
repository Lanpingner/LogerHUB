// Run against a gateway:   LOGGUBER_URL=ws://localhost:8080/ingest LOGGUBER_KEY=... npm start
// Build the client first:  pnpm --filter @logguber/client build
import express from 'express'
import { createLogger } from '@logguber/client'

const log = createLogger({
  url: process.env.LOGGUBER_URL ?? 'ws://localhost:8080/ingest',
  apiKey: process.env.LOGGUBER_KEY ?? 'dev-key',
  service: 'example-app',
  env: process.env.NODE_ENV ?? 'development',
  spool: { dir: process.env.SPOOL_DIR ?? './.logguber-spool' },
})

const app = express()
app.use(express.json())

app.use(log.expressMiddleware({
  // A stand-in for real auth: send  x-fake-auth: company:user:key
  resolveDims: (req) => {
    const [company_id, user_id, api_key_id] = String(req.headers['x-fake-auth'] ?? '').split(':')
    return { company_id, user_id, api_key_id }
  },
}))

app.get('/ok', (_req, res) => {
  log.info('doing some work')
  res.json({ ok: true })
})

app.post('/fail', (req, res) => {
  res.status(500).json({ error: 'something broke' })   // 5xx: the request body is captured, redacted
})

const server = app.listen(Number(process.env.PORT ?? 3000), () => {
  log.info('example app listening')
})

process.on('SIGTERM', async () => {
  server.close()
  await log.close()
  process.exit(0)
})
