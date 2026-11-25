import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import request from 'supertest'
import { createLogger } from '../src/logger'
import { createStubGateway, type StubGateway } from './helpers/stub-gateway'
import { appWith, base, tmp, waitFor } from './helpers/fixtures'
import type { ConsoleConfig, Logger, LoggerOptions } from '../src/types'

const gateways: StubGateway[] = []
const closeables: Logger[] = []

afterEach(async () => {
  for (const c of closeables.splice(0)) await c.close()
  for (const g of gateways.splice(0)) await g.close()
  delete process.env.NO_COLOR
})

/** Collects what the console wrote, standing in for stdout. */
function fakeStream(isTTY: boolean) {
  const written: string[] = []
  const stream = {
    isTTY,
    write(s: string) {
      written.push(s)
      return true
    },
  }
  return { stream: stream as unknown as NodeJS.WriteStream, written, text: () => written.join('') }
}

async function logger(console?: ConsoleConfig, extra: Partial<LoggerOptions> = {}): Promise<Logger> {
  const g = await createStubGateway()
  gateways.push(g)
  const log = createLogger({ ...base, url: g.url, console, ...extra })
  closeables.push(log)
  return log
}

/** Every visible line, stripped of ANSI codes and the trailing clear/move sequences. */
const lines = (text: string): string[] =>
  text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    .split('\n')
    .filter((l) => l.trim() !== '')

test('the console is silent unless it is switched on', async () => {
  const out = fakeStream(false)
  const log = await logger(undefined, {})
  log.info('nothing here')
  await log.flush()
  expect(out.written).toEqual([])
})

test('a plain line carries the timestamp, padded level and label', async () => {
  const out = fakeStream(false)
  const log = await logger({ enabled: true, label: 'app.js', stream: out.stream })
  log.warn('disk almost full')
  await log.flush()
  expect(lines(out.text())[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} WARN  \[app\.js\]: disk almost full$/)
})

test('the label falls back to the service when there is no script to name', async () => {
  const out = fakeStream(false)
  const argv = process.argv[1]
  process.argv[1] = ''
  try {
    const log = await logger({ enabled: true, stream: out.stream })
    log.info('x')
    await log.flush()
    expect(lines(out.text())[0]).toContain('[public-api]:')
  } finally {
    process.argv[1] = argv
  }
})

test('extra arguments are joined, and an Error contributes its stack', async () => {
  const out = fakeStream(false)
  const log = await logger({ enabled: true, stream: out.stream })
  const err = new Error('card declined')
  log.error('charge failed:', err)
  await log.flush()
  const text = out.text()
  expect(text).toContain('charge failed: Error: card declined')
  expect(text).toContain('at ') // the stack, which a single-argument logger dropped entirely
})

test('an object argument is rendered as JSON, in the message the gateway receives', async () => {
  const g = await createStubGateway()
  gateways.push(g)
  const log = createLogger({ ...base, url: g.url })
  closeables.push(log)
  log.info('order', { sku: 'A1', qty: 2 })
  await log.flush()
  expect(g.batches[0].entries[0].msg).toBe('order {"sku":"A1","qty":2}')
})

test('a trailing options object is options, not a message part', async () => {
  const g = await createStubGateway()
  gateways.push(g)
  const log = createLogger({ ...base, url: g.url })
  closeables.push(log)
  log.info('placed', { dims: { company_id: 'acme' } })
  log.info('mixed', { sku: 'A1' }, { dims: { company_id: 'globex' } })
  await log.flush()
  const [a, b] = g.batches.flatMap((x) => x.entries)
  expect(a).toMatchObject({ msg: 'placed', dims: { company_id: 'acme' } })
  // The data object stays in the message; only the options object is consumed.
  expect(b).toMatchObject({ msg: 'mixed {"sku":"A1"}', dims: { company_id: 'globex' } })
})

test('an argument whose toString throws costs the entry and is reported', async () => {
  const seen: Error[] = []
  const g = await createStubGateway()
  gateways.push(g)
  const log = createLogger({ ...base, url: g.url, onError: (e) => seen.push(e) })
  closeables.push(log)
  const hostile = { toString: () => { throw new Error('toString exploded') } }
  expect(() => log.info('before', hostile)).not.toThrow()
  log.info('after')
  await log.flush()
  expect(g.batches.flatMap((b) => b.entries).map((e) => e.msg)).toEqual(['after'])
  expect(seen.map((e) => e.message)).toContain('toString exploded')
})

test('the level filter applies locally while the gateway still receives everything', async () => {
  const out = fakeStream(false)
  const g = await createStubGateway()
  gateways.push(g)
  const log = createLogger({ ...base, url: g.url, console: { enabled: true, level: 'warn', stream: out.stream } })
  closeables.push(log)
  log.debug('quiet')
  log.error('loud')
  await log.flush()
  expect(lines(out.text())).toHaveLength(1)
  expect(out.text()).toContain('loud')
  expect(g.batches.flatMap((b) => b.entries).map((e) => e.msg)).toEqual(['quiet', 'loud'])
})

test('a secret is redacted before it reaches the screen, not only the network', async () => {
  const out = fakeStream(false)
  const log = await logger({ enabled: true, stream: out.stream })
  log.info('login', { meta: { password: 'hunter2', access_token: 'abc' } })
  await log.flush()
  expect(out.text()).not.toContain('hunter2')
  expect(out.text()).not.toContain('abc')
  expect(out.text()).toContain('[redacted]')
})

test('colour is used on a TTY and dropped off one', async () => {
  const tty = fakeStream(true)
  const plain = fakeStream(false)
  const a = await logger({ enabled: true, stream: tty.stream })
  a.error('red please')
  await a.flush()
  const b = await logger({ enabled: true, stream: plain.stream })
  b.error('no colour')
  await b.flush()
  expect(tty.text()).toContain('\x1B[31m')
  expect(plain.text()).not.toContain('\x1B[')
})

test('NO_COLOR wins over a TTY', async () => {
  process.env.NO_COLOR = '1'
  const out = fakeStream(true)
  const log = await logger({ enabled: true, stream: out.stream })
  log.error('plain')
  await log.flush()
  expect(out.text()).not.toContain('\x1B[31m')
})

test('the uncoloured line is appended to the file', async () => {
  const dir = tmp()
  const file = path.join(dir, 'logfile.log')
  const out = fakeStream(true)
  const log = await logger({ enabled: true, stream: out.stream, file })
  log.info('to disk')
  await log.flush()
  await waitFor(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('to disk'))
  const written = fs.readFileSync(file, 'utf8')
  expect(written).not.toContain('\x1B[')
  expect(written.trimEnd().endsWith('to disk')).toBe(true)
})

test('printLine writes without streaming anything', async () => {
  const out = fakeStream(false)
  const g = await createStubGateway()
  gateways.push(g)
  const log = createLogger({ ...base, url: g.url, console: { enabled: true, stream: out.stream } })
  closeables.push(log)
  log.printLine('── banner ──')
  await log.flush()
  expect(out.text()).toContain('── banner ──')
  expect(g.batches.flatMap((b) => b.entries)).toEqual([])
})

// ── request lines ────────────────────────────────────────────────────────────

test('a request line shows the auth tag, tags, flags and note', async () => {
  const out = fakeStream(false)
  const { app, entries } = await appWith(
    {
      captureIp: true,
      resolveMeta: () => ({
        auth: { type: 'P', cached: true },
        tags: { app: 'office', user: '42' },
        flags: ['ip-exc'],
      }),
      note: () => 'cached key',
    },
    { console: { enabled: true, stream: out.stream, timing: 'total' } },
  )
  await request(app).get('/users/1').expect(200)
  await entries()
  const line = lines(out.text()).find((l) => l.includes('/users/1'))
  expect(line).toBeDefined()
  expect(line).toContain('[APR]')
  expect(line).toContain(' app:office')
  expect(line).toContain(' user:42')
  expect(line).toContain(' ip-exc')
  expect(line).toContain(' — 200 (cached key)')
  expect(line).toMatch(/^\d{2}:\d{2}:\d{2} +\+\d+ms GET /)
})

test('the auth tag dims the letters that did not run, and keeps R live', async () => {
  const out = fakeStream(true)
  const { app, entries } = await appWith(
    { resolveMeta: () => ({ auth: { type: 'A', cached: false } }) },
    { console: { enabled: true, stream: out.stream } },
  )
  await request(app).get('/users/1').expect(200)
  await entries()
  const raw = out.text()
  // A ran uncached (red), P did not run (dim), R is never cached (red).
  expect(raw).toMatch(/\x1B\[31mA/)
  expect(raw).toMatch(/\x1B\[90mP/)
  expect(raw).toMatch(/\x1B\[31mR/)
})

test('the auth tag letters are configurable', async () => {
  const out = fakeStream(false)
  const { app, entries } = await appWith(
    { resolveMeta: () => ({ auth: { type: 'S' } }) },
    { console: { enabled: true, stream: out.stream, authTagLetters: ['S', 'T'], authTagAlways: [] } },
  )
  await request(app).get('/users/1').expect(200)
  await entries()
  expect(out.text()).toContain('[ST]')
})

test('resolveMeta cannot overwrite the measured fields', async () => {
  const { app, entries } = await appWith({
    resolveMeta: () => ({ status: 999, duration_ms: -1, app: 'office' }),
  })
  await request(app).get('/boom').expect(500)
  const [e] = await entries()
  expect(e.meta.http.status).toBe(500)
  expect(e.meta.http.duration_ms).toBeGreaterThanOrEqual(0)
  expect(e.meta.http.app).toBe('office')
})

test('a short request id is generated, reused on the in-flight line, and overridable', async () => {
  const out = fakeStream(true)
  const { app, entries } = await appWith(
    { pending: true },
    { console: { enabled: true, pending: true, stream: out.stream } },
  )
  await request(app).get('/users/1').expect(200)
  const [e] = await entries()
  const id = String(e.meta.http.request_id)
  expect(id).toMatch(/^[0-9a-f]{8}$/)
  // The in-flight line and the finished line must carry the same id.
  expect(out.text()).toContain(`[${id}]`)
  expect(out.text()).toContain('pending...')

  const second = await appWith({ requestId: () => 'my-own-id' })
  await request(second.app).get('/users/1').expect(200)
  const [f] = await second.entries()
  expect(f.meta.http.request_id).toBe('my-own-id')
})

test('the in-flight line is removed once the response finishes', async () => {
  const out = fakeStream(true)
  const { app, entries } = await appWith(
    { pending: true },
    { console: { enabled: true, pending: true, stream: out.stream } },
  )
  await request(app).get('/users/1').expect(200)
  await entries()
  // The block is redrawn empty: no pending line survives as the last thing written.
  const visible = lines(out.text())
  expect(visible.filter((l) => l.includes('pending...')).length).toBeLessThanOrEqual(1)
  expect(visible[visible.length - 1]).toContain('— 200')
})

test('captureIp is off by default and honours trusted hops when on', async () => {
  const off = await appWith({})
  await request(off.app).get('/users/1').expect(200)
  expect((await off.entries())[0].meta.http.ip).toBeUndefined()

  const on = await appWith({ captureIp: true, trustProxyHops: 1 })
  await request(on.app).get('/users/1').set('x-forwarded-for', '9.9.9.9, 10.0.0.1').expect(200)
  // One trusted hop: the rightmost entry is our proxy's view of the caller.
  expect((await on.entries())[0].meta.http.ip).toBe('10.0.0.1')
})

test('a throwing resolveMeta or note costs only those fields', async () => {
  const { app, entries } = await appWith({
    resolveMeta: () => { throw new Error('meta exploded') },
    note: () => { throw new Error('note exploded') },
  })
  await request(app).get('/users/1').expect(200)
  const [e] = await entries()
  expect(e.meta.http.status).toBe(200)
  expect(e.meta.http.note).toBeUndefined()
})

// ── WebSocket instrumentation ────────────────────────────────────────────────

/** A stand-in for a `ws` server and socket: the instrumentation only uses on/off/send. */
function fakeWsServer() {
  const server = new EventEmitter()
  const connect = (url = '/chat', headers: Record<string, string> = {}) => {
    const socket = new EventEmitter() as EventEmitter & { send: (data: unknown) => unknown }
    const sent: unknown[] = []
    socket.send = (data: unknown) => {
      sent.push(data)
      return true
    }
    const req = { url, headers, socket: { remoteAddress: '1.2.3.4' } }
    server.emit('connection', socket, req)
    return { socket, sent }
  }
  return { server: server as never, connect }
}

test('a connection logs open and close, with counts and duration', async () => {
  const g = await createStubGateway()
  gateways.push(g)
  const log = createLogger({ ...base, url: g.url })
  closeables.push(log)
  const { server, connect } = fakeWsServer()
  log.instrumentWs(server, { messages: 'meta', resolveDims: () => ({ company_id: 'acme' }) })

  const { socket } = connect('/chat?token=x')
  socket.emit('message', 'hello', false)
  socket.send('hi back')
  socket.emit('close', 1000, Buffer.from('bye'))
  await log.flush()

  const all = g.batches.flatMap((b) => b.entries) as Array<{ msg: string; meta?: any; dims?: any }>
  const open = all.find((e) => e.meta?.ws?.event === 'open')
  const close = all.find((e) => e.meta?.ws?.event === 'close')
  expect(open?.msg).toBe('WS open /chat')
  expect(open?.dims).toMatchObject({ company_id: 'acme' })
  expect(close?.meta.ws).toMatchObject({ code: 1000, reason: 'bye', messages_in: 1, messages_out: 1 })
  expect(close?.meta.ws.duration_ms).toBeGreaterThanOrEqual(0)
})

test('messages are not logged unless asked for, and payloads are redacted', async () => {
  const g = await createStubGateway()
  gateways.push(g)
  const log = createLogger({ ...base, url: g.url })
  closeables.push(log)
  const { server, connect } = fakeWsServer()
  log.instrumentWs(server, { messages: 'none' })
  const quiet = connect()
  quiet.socket.emit('message', '{"a":1}', false)
  await log.flush()
  expect(g.batches.flatMap((b) => b.entries).some((e: any) => e.meta?.ws?.event === 'message')).toBe(false)

  const g2 = await createStubGateway()
  gateways.push(g2)
  const loud = createLogger({ ...base, url: g2.url })
  closeables.push(loud)
  const second = fakeWsServer()
  loud.instrumentWs(second.server, { messages: 'payload' })
  const chatty = second.connect()
  chatty.socket.emit('message', '{"password":"hunter2","id":7}', false)
  await loud.flush()
  const msg = g2.batches.flatMap((b) => b.entries).find((e: any) => e.meta?.ws?.event === 'message') as any
  expect(msg.meta.ws.direction).toBe('in')
  expect(msg.meta.ws.payload).toMatchObject({ password: '[redacted]', id: 7 })
})

test('the application still receives its own messages and sends', async () => {
  const g = await createStubGateway()
  gateways.push(g)
  const log = createLogger({ ...base, url: g.url })
  closeables.push(log)
  const { server, connect } = fakeWsServer()
  log.instrumentWs(server, { messages: 'payload' })
  const { socket, sent } = connect()
  const heard: unknown[] = []
  socket.on('message', (d) => heard.push(d))
  socket.emit('message', 'ping', false)
  socket.send('pong')
  expect(heard).toEqual(['ping'])
  expect(sent).toEqual(['pong'])
})

test('ignore skips a connection, and the returned function detaches', async () => {
  const g = await createStubGateway()
  gateways.push(g)
  const log = createLogger({ ...base, url: g.url })
  closeables.push(log)
  const { server, connect } = fakeWsServer()
  const detach = log.instrumentWs(server, { ignore: (req) => req.url === '/internal' })
  connect('/internal')
  await log.flush()
  expect(g.batches.flatMap((b) => b.entries)).toEqual([])

  detach()
  connect('/chat')
  await log.flush()
  expect(g.batches.flatMap((b) => b.entries)).toEqual([])
})

test('a socket error is logged without breaking the socket', async () => {
  const g = await createStubGateway()
  gateways.push(g)
  const log = createLogger({ ...base, url: g.url })
  closeables.push(log)
  const { server, connect } = fakeWsServer()
  log.instrumentWs(server)
  const { socket } = connect()
  socket.on('error', () => {}) // the application's own handler
  expect(() => socket.emit('error', new Error('socket broke'))).not.toThrow()
  await log.flush()
  const e = g.batches.flatMap((b) => b.entries).find((x: any) => x.meta?.ws?.event === 'error') as any
  expect(e.level).toBe('error')
  expect(e.meta.error).toContain('socket broke')
})
