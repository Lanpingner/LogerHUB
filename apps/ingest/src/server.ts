import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { HELLO_DEFAULTS, LEVELS, LOKI_LIMITS, type BatchFrame, type LogEntry } from '@logguber/shared'
import { openStore, type Store } from './store.ts'
import { clientIp, ipAllowed, parseKey, secretMatches } from './auth.ts'
import { timingSafeEqual } from 'node:crypto'
import { pushToLoki } from './loki.ts'
import { createBus, type Filter, type LiveEntry } from './bus.ts'
import { rollupRows } from './rollup.ts'

const PORT = Number(process.env.PORT ?? 8080)
const DB_FILE = process.env.LOGGUBER_DB ?? './data/logguber.db'
const LOKI_URL = process.env.LOKI_URL ?? 'http://localhost:3100'
const TRUSTED_PROXY_HOPS = Number(process.env.TRUSTED_PROXY_HOPS ?? 0)
// Preferred over the hop count: correct under any number of hops, and a request
// that reaches the gateway directly cannot name its own address.
const TRUSTED_PROXY_CIDRS = (process.env.TRUSTED_PROXY_CIDRS ?? '')
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean)
const CONSOLE_SECRET = process.env.CONSOLE_SECRET ?? ''
// Loki rejects samples older than reject_old_samples_max_age (7d in deploy/loki.yaml);
// future samples are refused past its creation grace period, so they are clamped.
const MAX_PAST_MS = 7 * 24 * 60 * 60 * 1000
const MAX_MSG_BYTES = 8 * 1024
const MAX_DIMS = 16
const MAX_DIM_BYTES = 256
const MAX_META_BYTES = 32 * 1024
/** Concurrent streams one key may hold. One process per host needs very few. */
const MAX_CONNECTIONS_PER_KEY = Number(process.env.MAX_CONNECTIONS_PER_KEY ?? 16)
/** Token bucket per key, so one key cannot monopolise the SQLite writer. */
const BATCH_RATE_PER_SEC = Number(process.env.BATCH_RATE_PER_SEC ?? 20)
const BATCH_BURST = Number(process.env.BATCH_BURST ?? 50)
const ENV_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/i

const store: Store = openStore(DB_FILE)
const bus = createBus()
const levelSet = new Set<string>(LEVELS)

// Live connections per key, so revoking a key can close its open sockets.
const liveByKeyId = new Map<string, Set<WebSocket>>()

/** Constant-time compare for the console's shared secret. Never accepted from a
 *  query string: URLs land in proxy and access logs. */
function consoleSecretOk(header: string | string[] | undefined): boolean {
  if (!CONSOLE_SECRET || typeof header !== 'string') return false
  const a = Buffer.from(header)
  const b = Buffer.from(CONSOLE_SECRET)
  return a.length === b.length && timingSafeEqual(a, b)
}

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
    // Clamp rather than only validate: a future timestamp passes a window check
    // but is then refused by Loki, and a backdated one rewrites a usage hour the
    // operator has already read.
    const parsed = Date.parse(String(e.ts ?? ''))
    const usable = Number.isFinite(parsed) && now - parsed < MAX_PAST_MS
    const ts = new Date(usable ? Math.min(parsed, now) : now).toISOString()

    const level = levelSet.has(String(e.level)) ? (e.level as LogEntry['level']) : 'info'

    const dims: Record<string, string> = {}
    if (e.dims && typeof e.dims === 'object') {
      for (const [k, v] of Object.entries(e.dims as Record<string, unknown>)) {
        if (typeof v !== 'string' || !v) continue
        if (Object.keys(dims).length >= MAX_DIMS) break
        // Dimension values become usage_rollup primary keys, so an unbounded
        // value is an unbounded row.
        dims[k.slice(0, 64)] = v.length > MAX_DIM_BYTES ? v.slice(0, MAX_DIM_BYTES) : v
      }
    }

    const entry: LogEntry = { ts, level, msg: msg.length > MAX_MSG_BYTES ? msg.slice(0, MAX_MSG_BYTES) : msg, dims }
    if (e.kind === 'request') entry.kind = 'request'
    if (e.meta && typeof e.meta === 'object') {
      let meta: Record<string, unknown> | undefined
      try {
        const serialised = JSON.stringify(e.meta)
        if (serialised && serialised.length <= MAX_META_BYTES) meta = e.meta as Record<string, unknown>
      } catch {
        // A meta that will not serialise is dropped rather than carried.
      }
      if (meta) entry.meta = meta
      else rejected++
    }
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

  // Dedupe, per key. A claim is provisional until the batch is actually stored:
  // only a *completed* claim makes a retry a duplicate. Acking an incomplete
  // claim is what silently destroyed batches whenever Loki hiccuped, because the
  // client deletes its spooled copy the moment it sees an ack.
  const claim = store.claimBatch(frame.id, conn.keyId)
  if (claim === 'duplicate') {
    log('duplicate batch', { id: frame.id, key: conn.keyId })
    return { ok: true }
  }

  const levels = store.settings().levels.map((l) => l.key)

  // Fan out before storage: live tail must not wait on Loki. This is the one
  // step that is allowed to happen for a batch that later fails to store —
  // the tail is best-effort by design, and Loki holds the durable copy.
  bus.publish(entries.map((e) => ({ ...e, service: conn.service, env: conn.env })) as LiveEntry[])

  try {
    await pushToLoki(entries, conn.service, conn.env, { url: LOKI_URL, metadataKeys: levels.filter((l) => l !== 'service') })
  } catch (e) {
    // Hand the id back so the client's retry is treated as a retry.
    store.releaseBatch(frame.id, conn.keyId)
    store.logError(conn.keyId, 'loki_push_failed', String(e))
    return { ok: false, reason: 'loki unavailable', retryable: true }
  }

  // Counters move only once Loki has the lines, so usage never claims traffic
  // that was never stored.
  try {
    store.rollup(rollupRows(entries, conn.service, levels))
    const folded = store.takeOverflowCount()
    // Worth a record: it means a client is sending high-cardinality dimension
    // values, and the operator's breakdown for that hour is incomplete.
    if (folded > 0) store.logError(conn.keyId, 'usage_cardinality_capped', folded + ' combinations folded')
  } catch (e) {
    store.logError(conn.keyId, 'rollup_failed', String(e))
    // The lines are in Loki; completing the claim keeps a retry from writing
    // them twice. The counters are short by this batch, which is the lesser
    // wrong and is recorded above.
  }
  store.completeBatch(frame.id, conn.keyId)

  // These arrive from the client, so they are clamped before they are stored:
  // unvalidated they are an unbounded write primitive into ingest_errors.
  const count = (v: unknown): number => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 1e9) : 0
  }
  const droppedEntries = count(frame.droppedSinceLast)
  const prunedBatches = count(frame.prunedBatchesSinceLast)
  if (droppedEntries || prunedBatches) {
    store.logError(conn.keyId, 'client_reported_loss', 'entries=' + droppedEntries + ' batches=' + prunedBatches)
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

  const ip = clientIp(
    req.socket.remoteAddress ?? '',
    req.headers['x-forwarded-for'] as string | undefined,
    TRUSTED_PROXY_HOPS,
    TRUSTED_PROXY_CIDRS,
  )
  if (!ipAllowed(ip, key.ip_allowlist, store.settings().globalIpAllowlist)) {
    // The address is recorded for the operator but never echoed to the caller:
    // telling them which address we resolved confirms whether their spoofed
    // X-Forwarded-For was believed.
    store.logError(key.key_id, 'ip_rejected', ip)
    return { close: 4403, why: 'ip not allowed (' + ip + ')' }
  }

  const service = url.searchParams.get('service') ?? ''
  const env = url.searchParams.get('env') ?? ''
  if (!service || !key.service_scope.includes(service)) return { close: 4403, why: 'service out of scope' }
  // `env` becomes a Loki stream label. Unbounded values mean unbounded streams,
  // so it is shape-checked even when the key's scope allows any environment.
  if (!ENV_PATTERN.test(env)) {
    store.logError(key.key_id, 'env_rejected', env.slice(0, 64))
    return { close: 4403, why: 'env not acceptable' }
  }
  if (key.env_scope && !key.env_scope.includes(env)) return { close: 4403, why: 'env out of scope' }

  store.touchKey(key.id, ip)
  return { conn: { keyId: key.key_id, service, env } }
}

// Without maxPayload, ws defaults to 100 MB — a hundred times what the hello
// frame advertises, buffered in memory before it is parsed.
const wss = new WebSocketServer({ noServer: true, maxPayload: HELLO_DEFAULTS.maxBatchBytes })

/** Per-key token buckets, refilled on read. */
const buckets = new Map<string, { tokens: number; at: number }>()
function allowBatch(keyId: string): boolean {
  const now = Date.now()
  const b = buckets.get(keyId) ?? { tokens: BATCH_BURST, at: now }
  b.tokens = Math.min(BATCH_BURST, b.tokens + ((now - b.at) / 1000) * BATCH_RATE_PER_SEC)
  b.at = now
  buckets.set(keyId, b)
  if (b.tokens < 1) return false
  b.tokens -= 1
  return true
}

wss.on('connection', (ws: WebSocket, _req: IncomingMessage, conn: Conn) => {
  // The connection is pinned to this (key, service, env) for its lifetime, so
  // individual messages cannot name a service at all.
  let set = liveByKeyId.get(conn.keyId)
  if (!set) { set = new Set(); liveByKeyId.set(conn.keyId, set) }

  // One key must not be able to exhaust the proxy's connection table and lock
  // every other key out.
  if (set.size >= MAX_CONNECTIONS_PER_KEY) {
    store.logError(conn.keyId, 'too_many_connections', String(set.size))
    ws.close(4429, 'too many connections')
    return
  }
  set.add(ws)

  ws.send(JSON.stringify({ t: 'hello', ...HELLO_DEFAULTS }))

  // A ping nobody answers proves nothing. Track the pong and drop a socket that
  // misses two, so half-open connections are reaped instead of accumulating.
  let missedPongs = 0
  ws.on('pong', () => { missedPongs = 0 })
  const ping = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return
    if (missedPongs >= 2) {
      ws.terminate()
      return
    }
    missedPongs++
    ws.ping()
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
      if (!allowBatch(conn.keyId)) {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ t: 'nack', id: frame.id, reason: 'rate limited', retryable: true }))
        }
        return
      }
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
    if (!consoleSecretOk(req.headers['x-console-secret'])) {
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
    if (!consoleSecretOk(req.headers['x-console-secret'])) {
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
    // Check the key before reading the body: otherwise anyone who can reach the
    // proxy can make the gateway buffer and parse a megabyte per request with no
    // credential at all. `service`/`env` come from the query string here, the way
    // the stream does; the body is only consulted once the key is known.
    const early = parseKey(req.headers.authorization)
    if (!early || !store.keyByKeyId(early.keyId)) {
      return json(res, 401, { error: 'unauthorised' })
    }
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
        // The documented HTTP payload names the field `batch_id`, while the
        // WebSocket frame uses `id`. Accept either so the documented example works.
        const withId = body as BatchFrame & { service?: string; env?: string; batch_id?: string }
        if (!withId.id && withId.batch_id) withId.id = withId.batch_id
        const fakeUrl = new URL('http://x/?service=' + encodeURIComponent(body.service ?? '') + '&env=' + encodeURIComponent(body.env ?? ''))
        const auth = authorise(req, fakeUrl)
        if ('close' in auth) {
          log('request rejected', { why: auth.why })
          return json(res, auth.close === 4401 ? 401 : 403, {
            error: auth.close === 4401 ? 'unauthorised' : 'forbidden',
          })
        }
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
    // Upgrade first, then close with our code, so the client can tell permanent
    // from transient. The reason is deliberately opaque: the close code already
    // says what the client needs, and the detail is an oracle.
    const opaque = auth.close === 4401 ? 'unauthorised' : 'forbidden'
    wss.handleUpgrade(req, socket, head, (ws) => ws.close(auth.close, opaque))
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
