import { EventEmitter } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { createExpressMiddleware } from '../src/middleware'
import type { Logger } from '../src/types'
import { appWith, waitFor } from './helpers/fixtures'

test('logs one line per request with route, status and duration', async () => {
  const { app, entries } = await appWith({})
  await request(app).get('/users/1').expect(200)
  const e = await entries()
  expect(e).toHaveLength(1)
  expect(e[0]).toMatchObject({ kind: 'request', level: 'info', msg: 'GET /users/:id 200' })
  expect(e[0].meta.http).toMatchObject({ method: 'GET', route: '/users/:id', path: '/users/1', status: 200 })
  expect(e[0].meta.http.duration_ms).toBeGreaterThanOrEqual(0)
  expect(typeof e[0].meta.http.request_id).toBe('string')
})

test('levels follow status: 4xx warn, 5xx error', async () => {
  const { app, entries } = await appWith({})
  await request(app).get('/missing')
  await request(app).get('/boom')
  expect((await entries()).map((e) => e.level)).toEqual(['warn', 'error'])
})

test('an unrouted 404 and a thrown error still produce lines, with a bounded route', async () => {
  const { app, entries } = await appWith({})
  await request(app).get('/nothing/here/123').expect(404)
  await request(app).get('/throws').expect(500)
  const e = await entries()
  expect(e.map((x) => x.msg)).toEqual(['GET unmatched 404', 'GET /throws 500'])
  expect(e[0].meta.http.path).toBe('/nothing/here/123')
})

test('a mounted router reports the full route pattern', async () => {
  const { app, entries } = await appWith({})
  await request(app).get('/v1/items/9?x=secret')
  const [e] = await entries()
  expect(e.meta.http).toMatchObject({ route: '/v1/items/:sku', path: '/v1/items/9' })
})

test('request_id comes from x-request-id when present', async () => {
  const { app, entries } = await appWith({})
  await request(app).get('/users/1').set('X-Request-Id', 'abc-123')
  expect((await entries())[0].meta.http.request_id).toBe('abc-123')
})

test('resolveDims attaches dimensions and ignore skips requests', async () => {
  const { app, entries } = await appWith({
    resolveDims: () => ({ company_id: 'acme', dropped: undefined }),
    ignore: (r) => r.path === '/health',
  })
  await request(app).get('/health')
  await request(app).get('/users/1')
  const e = await entries()
  expect(e).toHaveLength(1)
  expect(e[0].dims).toEqual({ company_id: 'acme' })
})

test('a throwing resolveDims costs the dimensions, not the entry or the request', async () => {
  const { app, entries } = await appWith({
    resolveDims: () => {
      throw new Error('no user')
    },
  })
  await request(app).get('/users/1').expect(200)
  const e = await entries()
  expect(e).toHaveLength(1)
  expect(e[0].dims).toBeUndefined()
})

test('a throwing ignore does not skip the request', async () => {
  const { app, entries } = await appWith({
    ignore: () => {
      throw new Error('bad predicate')
    },
  })
  await request(app).get('/users/1').expect(200)
  expect(await entries()).toHaveLength(1)
})

test('on-error captures bodies only for failures (default mode)', async () => {
  const { app, entries } = await appWith({})
  await request(app).post('/echo').send({ a: 1 }) // 200
  await request(app).post('/fail').send({ a: 1 }) // 500
  const e = await entries()
  expect(e[0].meta.http.req.body).toBeUndefined()
  expect(e[0].meta.http.res.body).toBeUndefined()
  expect(e[1].meta.http.req.body).toEqual({ a: 1 })
  expect(e[1].meta.http.res.body).toMatchObject({ error: 'nope' })
})

test('captured bodies are redacted and truncated', async () => {
  const { app, entries } = await appWith({ bodies: 'always', maxBodyBytes: 64 })
  await request(app).post('/fail').send({ password: 'hunter2', pad: 'x'.repeat(500) })
  const body = (await entries())[0].meta.http.req.body
  expect(JSON.stringify(body)).not.toContain('hunter2')
  expect(body).toMatchObject({ _truncated: true })
})

test('request and response bodies are redacted by key before they leave the process', async () => {
  const { app, entries, gateway } = await appWith({ bodies: 'always' })
  await request(app).post('/fail').send({ password: 'hunter2', name: 'ann' })
  await entries()
  const wire = JSON.stringify(gateway.batches)
  expect(wire).not.toContain('hunter2')
  expect(wire).toContain('ann')
})

test('allowFields limits which top-level fields are captured', async () => {
  const { app, entries } = await appWith({ bodies: 'always', allowFields: ['a'] })
  await request(app).post('/echo').send({ a: 1, b: 2 })
  const [e] = await entries()
  expect(e.meta.http.req.body).toEqual({ a: 1 })
  expect(e.meta.http.res.body).toEqual({ a: 1 })
})

test('never captures no bodies even for errors', async () => {
  const { app, entries } = await appWith({ bodies: 'never' })
  await request(app).post('/fail').send({ a: 1 })
  const [e] = await entries()
  expect(e.meta.http.req.body).toBeUndefined()
  expect(e.meta.http.res.body).toBeUndefined()
})

test('sample always captures errors; sampleRate 0 captures no successes, 1 captures all', async () => {
  const zero = await appWith({ bodies: 'sample', sampleRate: 0 })
  await request(zero.app).post('/echo').send({ a: 1 })
  await request(zero.app).post('/fail').send({ a: 1 })
  const z = await zero.entries()
  expect(z[0].meta.http.req.body).toBeUndefined()
  expect(z[1].meta.http.req.body).toEqual({ a: 1 })

  const one = await appWith({ bodies: 'sample', sampleRate: 1 })
  await request(one.app).post('/echo').send({ a: 1 })
  const o = await one.entries()
  expect(o[0].meta.http.req.body).toEqual({ a: 1 })
  expect(o[0].meta.http.res.body).toEqual({ a: 1 })
})

test('response bodies are only captured for JSON-ish content types', async () => {
  const { app, entries } = await appWith({ bodies: 'always' })
  const res = await request(app).get('/text').expect(200)
  expect(res.text).toBe('plain words')
  expect((await entries())[0].meta.http.res.body).toBeUndefined()
})

test('a response over maxBodyBytes is marked truncated and still delivered whole', async () => {
  const { app, entries } = await appWith({ bodies: 'always', maxBodyBytes: 64 })
  const res = await request(app).get('/big').expect(200)
  expect(res.body.pad).toHaveLength(500)
  expect((await entries())[0].meta.http.res.body).toEqual({ _truncated: true })
})

test('chunked writes are reassembled, and the cap applies mid-stream', async () => {
  const ok = await appWith({ bodies: 'always' })
  const res = await request(ok.app).get('/chunked')
  expect(res.body.a).toHaveLength(100)
  expect((await ok.entries())[0].meta.http.res.body.a).toHaveLength(100)

  const capped = await appWith({ bodies: 'always', maxBodyBytes: 50 })
  const res2 = await request(capped.app).get('/chunked')
  expect(res2.body.a).toHaveLength(100)
  expect((await capped.entries())[0].meta.http.res.body).toEqual({ _truncated: true })
})

test('calling res.end twice captures the first body only and logs one line', async () => {
  const { app, entries } = await appWith({ bodies: 'always' })
  await request(app).get('/double-end')
  const e = await entries()
  expect(e).toHaveLength(1)
  expect(e[0].meta.http.res.body).toEqual({ a: 1 })
})

test('handles array-valued and numeric headers without crashing', async () => {
  const { app, entries } = await appWith({ bodies: 'always' })
  await request(app).post('/echo').set('Content-Type', 'application/json').send({ a: 1 })
  const h = (await entries())[0].meta.http.req.headers
  expect(typeof h['content-length']).toBe('string')
  expect(Object.values(h).every((v) => typeof v === 'string')).toBe(true)
})

function fakeExchange(headers: Record<string, unknown>) {
  const logged: any[] = []
  const logger = { log: (...a: unknown[]) => void logged.push(a) } as unknown as Logger
  const req: any = { method: 'GET', url: '/x', headers }
  const res: any = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headersSent: true,
    getHeader: () => undefined,
    write: () => true,
    end: () => res,
  })
  return { logger, req, res, logged }
}

test('coerces array and numeric header values and survives odd ones', () => {
  const { logger, req, res, logged } = fakeExchange({
    'content-length': 12,
    accept: ['a/b', 'c/d'],
    'user-agent': undefined,
    host: { weird: true },
  })
  createExpressMiddleware(logger)(req, res, () => {})
  res.emit('finish')
  expect(logged[0][2].meta.http.req.headers).toEqual({ 'content-length': '12', accept: 'a/b, c/d' })
})

test('headerAllowlist from the logger options is honoured', async () => {
  const { app, entries } = await appWith({}, { headerAllowlist: ['x-tenant'] })
  await request(app).get('/users/1').set('X-Tenant', 't1').set('User-Agent', 'curl')
  expect((await entries())[0].meta.http.req.headers).toEqual({ 'x-tenant': 't1' })
})

test('default header allowlist applies when none is configured', async () => {
  const { app, entries } = await appWith({})
  await request(app).get('/users/1').set('Authorization', 'Bearer abc').set('User-Agent', 'curl')
  expect((await entries())[0].meta.http.req.headers).toEqual({ host: expect.any(String), 'user-agent': 'curl' })
})

test('leaves a streaming response unbuffered and unbroken', async () => {
  const { app, entries } = await appWith({ bodies: 'always' })
  const res = await request(app).get('/stream').expect(200)
  expect(res.text).toBe('abc')
  expect((await entries())[0].meta.http.res?.body).toBeUndefined()
})

test('a JSON-parseable body on an event-stream or multipart type is still not captured', async () => {
  const { app, entries } = await appWith({ bodies: 'always' })
  await request(app).get('/stream-json').expect(200)
  expect((await entries())[0].meta.http.res.body).toBeUndefined()
})

test('a client that disconnects before the response still produces one line, flagged aborted', async () => {
  const { app, entries } = await appWith({})
  const server = createServer(app).listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  try {
    const { port } = server.address() as AddressInfo
    const req = httpRequest({ port, host: '127.0.0.1', path: '/hang' })
    req.on('error', () => {})
    req.end()
    await new Promise((r) => setTimeout(r, 50))
    req.destroy()
    await waitFor(() => server.listenerCount('request') > 0)
    await new Promise((r) => setTimeout(r, 50))
    const e = await entries()
    expect(e).toHaveLength(1)
    expect(e[0].meta.http).toMatchObject({ route: '/hang', status: 499, aborted: true })
    expect(e[0].level).toBe('warn')
  } finally {
    server.close()
  }
})

test('a finished response is logged once, and the close that follows does not duplicate it', async () => {
  const { app, entries } = await appWith({})
  await request(app).get('/users/1')
  expect(await entries()).toHaveLength(1)
})

test('ordinary log calls never carry kind, even if one is smuggled in', async () => {
  const { log, entries } = await appWith({})
  log.info('plain')
  log.warn('plain2', { kind: 'request' } as never)
  const e = await entries()
  expect(e).toHaveLength(2)
  for (const x of e) expect('kind' in x).toBe(false)
})
