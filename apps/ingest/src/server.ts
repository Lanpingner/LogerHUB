import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { HELLO_DEFAULTS, LEVELS, LOKI_LIMITS, type BatchFrame, type LogEntry } from '@logguber/shared'
import { openStore, type Store } from './store.ts'
import { clientIp, ipAllowed, parseKey, secretMatches } from './auth.ts'
import { pushToLoki } from './loki.ts'
import { createBus, type Filter, type LiveEntry } from './bus.ts'
import { rollupRows } from './rollup.ts'

const PORT = Number(process.env.PORT ?? 8080)
const DB_FILE = process.env.LOGGUBER_DB ?? './data/logguber.db'
const LOKI_URL = process.env.LOKI_URL ?? 'http://localhost:3100'
const TRUSTED_PROXY_HOPS = Number(process.env.TRUSTED_PROXY_HOPS ?? 0)
const CONSOLE_SECRET = process.env.CONSOLE_SECRET ?? ''
const MAX_SKEW_MS = 7 * 24 * 60 * 60 * 1000

const store: Store = openStore(DB_FILE)
const bus = createBus()
const levelSet = new Set<string>(LEVELS)

// Live connections per key, so revoking a key can close its open sockets.
const liveByKeyId = new Map<string, Set<WebSocket>>()

function log(msg: string, extra?: Record<string, unknown>) {
  // The gateway never logs into itself — stdout only, no feedback loop.
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }) + '\n')
}

interface Conn { keyId: string; service: string; env: string }

function validate(entries: unknown): { ok: LogEntry[]; rejected: number } {
  if (!Array.isArray(entries)) return { ok: [], rejected: 0 }
  const ok: LogEntry[] = []
  let rejected = 0
  const now = Date.now()
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') { rejected++; continue }
    const e = raw as Record<string, unknown>
    const msg = typeof e.msg === 'string' ? e.msg : ''
    if (!msg) { rejected++; continue }
    const parsed = Date.parse(String(e.ts ?? ''))
    const ts = Number.isFinite(parsed) && Math.abs(now - parsed) < MAX_SKEW_MS
      ? new Date(parsed).toISOString()
      : new Date(now).toISOString()
    const level = levelSet.has(String(e.level)) ? (e.level as LogEntry['level']) : 'info'
    const dims: Record<string, string> = {}
    if (e.dims && typeof e.dims === 'object') {
      for (const [k, v] of Object.entries(e.dims as Record<string, unknown>)) {
        if (typeof v === 'string' && v) dims[k] = v
      }
    }
    const entry: LogEntry = { ts, level, msg, dims }
    if (e.kind === 'request') entry.kind = 'request'
    if (e.meta && typeof e.meta === 'object') entry.meta = e.meta as Record<string, unknown>
    ok.push(entry)
  }
  return { ok, rejected }
}

async function handleBatch(conn: Conn, frame: BatchFrame): Promise<{ ok: true } | { ok: false; reason: string; retryable: boolean }> {
  if (!frame.id || typeof frame.id !== 'string') return { ok: false, reason: 'missing batch id', retryable: false }
  if (!Array.isArray(frame.entries) || frame.entries.length === 0) {
    return { ok: false, reason: 'empty batch', retryable: false }
  }
  if (frame.entries.length > HELLO_DEFAULTS.maxEntriesPerBatch) {
    return { ok: false, reason: 'too many entries', retryable: false }
  }

  const { ok: entries, rejected } = validate(frame.entries)
  if (rejected) store.logError(conn.keyId, 'entries_rejected', `${rejected} of ${frame.entries.length}`)
  if (!entries.length) return { ok: false, reason: 'no valid entries', retryable: false }

  // Dedupe: a conflict means this batch already landed, so ack without doing the work again.
  // Without this, the client's reconnect resends would double-count usage.
  if (!store.claimBatch(frame.id, conn.keyId)) {
    log('duplicate batch', { id: frame.id, key: conn.keyId })
    return { ok: true }
  }

  const levels = store.settings().levels.map((l) => l.key)
  try {
    store.rollup(rollupRows(entries, conn.service, levels))
  } catch (e) {
    store.logError(conn.keyId, 'rollup_failed', String(e))
    return { ok: false, reason: 'rollup failed', retryable: true }
  }

  // Fan out before the Loki push: live tail must not wait on storage.
  bus.publish(entries.map((e) => ({ ...e, service: conn.service, env: conn.env })) as LiveEntry[])

  try {
    await pushToLoki(entries, conn.service, conn.env, { url: LOKI_URL, metadataKeys: levels.filter((l) => l !== 'service') })
  } catch (e) {
    store.logError(conn.keyId, 'loki_push_failed', String(e))
    return { ok: false, reason: 'loki unavailable', retryable: true }
  }

  if (frame.droppedSinceLast || frame.prunedBatchesSinceLast) {
    store.logError(conn.keyId, 'client_reported_loss',
      `entries=${frame.droppedSinceLast ?? 0} batches=${frame.prunedBatchesSinceLast ?? 0}`)
  }
  return { ok: true }
}

/** Handshake: everything security-related happens once, here. */
function authorise(req: IncomingMessage, url: URL): { conn: Conn } | { close: number; why: string } {
  const parsed = parseKey(req.headers.authorization)
  if (!parsed) return { close: 4401, why: 'malformed key' }

  const key = store.keyByKeyId(parsed.keyId)
  if (!key || key.disabled_at) return { close: 4401, why: 'unknown or disabled key' }
  if (!secretMatches(parsed.secret, key.secret_hash)) return { close: 4401, why: 'bad secret' }

  const ip = clientIp(req.socket.remoteAddress ?? '', req.headers['x-forwarded-for'] as string | undefined, TRUSTED_PROXY_HOPS)
  if (!ipAllowed(ip, key.ip_allowlist, store.settings().globalIpAllowlist)) {
    store.logError(key.key_id, 'ip_rejected', ip)
    return { close: 4403, why: `ip ${ip} not allowed` }
  }

  const service = url.searchParams.get('service') ?? ''
  const env = url.searchParams.get('env') ?? ''
  if (!service || !key.service_scope.includes(service)) return { close: 4403, why: 'service out of scope' }
  if (key.env_scope && !key.env_scope.includes(env)) return { close: 4403, why: 'env out of scope' }

  store.touchKey(key.id, ip)
  return { conn: { keyId: key.key_id, service, env } }
}

const wss = new WebSocketServer({ noServer: true })

wss.on('connection', (ws: WebSocket, _req: IncomingMessage, conn: Conn) => {
  // The connection is pinned to this (key, service, env) for its lifetime, so
  // individual messages cannot name a service at all.
  let set = liveByKeyId.get(conn.keyId)
  if (!set) { set = new Set(); liveByKeyId.set(conn.keyId, set) }
  set.add(ws)

  ws.send(JSON.stringify({ t: 'hello', ...HELLO_DEFAULTS }))

  const ping = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping()
  }, 30_000)
  ping.unref?.()

  ws.on('message', (raw) => {
    void (async () => {
      let frame: BatchFrame
      try {
        frame = JSON.parse(raw.toString()) as BatchFrame
      } catch {
        return // malformed JSON: ignore rather than killing the stream
      }
      if (frame?.t !== 'batch') return
      try {
        const res = await handleBatch(conn, frame)
        if (ws.readyState !== ws.OPEN) return
        ws.send(JSON.stringify(res.ok
          ? { t: 'ack', id: frame.id }
          : { t: 'nack', id: frame.id, reason: res.reason, retryable: res.retryable }))
      } catch (e) {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ t: 'nack', id: frame.id, reason: 'internal error', retryable: true }))
        }
        store.logError(conn.keyId, 'batch_failed', String(e))
      }
    })()
  })

  ws.on('close', () => {
    clearInterval(ping)
    liveByKeyId.get(conn.keyId)?.delete(ws)
  })
  ws.on('error', () => {})
})

function json(res: ServerResponse, code: number, body: unknown) {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}

function parseFilter(url: URL): Filter {
  const list = (k: string) => url.searchParams.get(k)?.split(',').filter(Boolean)
  let dims: Record<string, string> | undefined
  const rawDims = url.searchParams.get('dims')
  if (rawDims) { try { dims = JSON.parse(rawDims) as Record<string, string> } catch {} }
  return { services: list('services'), envs: list('envs'), levels: list('levels'), dims }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  if (url.pathname === '/health') {
    return json(res, 200, { ok: true, subscribers: bus.subscriberCount() })
  }

  // Live stream for the console: SSE, authenticated with a shared secret.
  if (url.pathname === '/internal/live') {
    if (!CONSOLE_SECRET || url.searchParams.get('secret') !== CONSOLE_SECRET) {
      return json(res, 401, { error: 'unauthorised' })
    }
    const filter = parseFilter(url)
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })
    for (const e of bus.backlog(filter)) res.write(`data: ${JSON.stringify(e)}\n\n`)
    const unsubscribe = bus.subscribe(filter, (e) => res.write(`data: ${JSON.stringify(e)}\n\n`))
    const beat = setInterval(() => res.write(': ping\n\n'), 25_000)
    beat.unref?.()
    req.on('close', () => { clearInterval(beat); unsubscribe() })
    return
  }

  // Tell the gateway a key changed, so a revoked key's open sockets close now
  // rather than at the next handshake.
  if (url.pathname === '/internal/reload' && req.method === 'POST') {
    if (!CONSOLE_SECRET || req.headers['x-console-secret'] !== CONSOLE_SECRET) {
      return json(res, 401, { error: 'unauthorised' })
    }
    let closed = 0
    for (const [keyId, sockets] of liveByKeyId) {
      const key = store.keyByKeyId(keyId)
      if (key && !key.disabled_at) continue
      for (const ws of sockets) { try { ws.close(4401, 'revoked') } catch {}; closed++ }
      liveByKeyId.delete(keyId)
    }
    return json(res, 200, { closed })
  }

  // HTTP fallback: same validation, dedupe and rollup path as the stream.
  // For curl debugging and environments where outbound WebSocket is blocked.
  if (url.pathname === '/v1/logs' && req.method === 'POST') {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > HELLO_DEFAULTS.maxBatchBytes) { req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      void (async () => {
        let body: BatchFrame & { service?: string; env?: string }
        try {
          body = JSON.parse(Buffer.concat(chunks).toString()) as BatchFrame & { service?: string; env?: string }
        } catch {
          return json(res, 400, { error: 'invalid json' })
        }
        const fakeUrl = new URL('http://x/?service=' + encodeURIComponent(body.service ?? '') + '&env=' + encodeURIComponent(body.env ?? ''))
        const auth = authorise(req, fakeUrl)
        if ('close' in auth) return json(res, auth.close === 4401 ? 401 : 403, { error: auth.why })
        const result = await handleBatch(auth.conn, body)
        return result.ok
          ? json(res, 202, { accepted: body.entries?.length ?? 0 })
          : json(res, result.retryable ? 503 : 400, { error: result.reason })
      })()
    })
    return
  }

  json(res, 404, { error: 'not found' })
})

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  if (url.pathname !== '/v1/stream') {
    socket.destroy()
    return
  }
  const auth = authorise(req, url)
  if ('close' in auth) {
    log('handshake rejected', { why: auth.why })
    // Upgrade first, then close with our code, so the client can tell permanent from transient.
    wss.handleUpgrade(req, socket, head, (ws) => ws.close(auth.close, auth.why))
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, auth.conn))
})

const pruner = setInterval(() => store.prune(), 60 * 60 * 1000)
pruner.unref?.()

server.on('error', (err) => {
  // Fail loudly and exit rather than throwing an unhandled 'error' event: a half-started
  // gateway that looks alive is worse than one that is plainly dead.
  const e = err as NodeJS.ErrnoException
  log('server error', { code: e.code, message: e.message })
  try { store.close() } catch {}
  process.exit(1)
})

server.listen(PORT, () => log('ingest listening', { port: PORT, loki: LOKI_URL, db: DB_FILE }))

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log('shutting down')
    server.close(() => { store.close(); process.exit(0) })
    setTimeout(() => process.exit(0), 3000).unref?.()
  })
}
