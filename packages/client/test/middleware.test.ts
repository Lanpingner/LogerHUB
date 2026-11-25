import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { createExpressMiddleware } from '../src/middleware'
import type { Logger } from '../src/types'
import { Readable } from 'node:stream'
import compression from 'compression'
import { appWith, sleep, useExpress, waitFor } from './helpers/fixtures'

describe.each([4, 5] as const)('express %i', (major) => {
beforeAll(() => useExpress(major))

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

test('on-error treats a 4xx as an error: its bodies are captured', async () => {
  const { app, entries } = await appWith({})
  app.post('/bad', (_req, res) => void res.status(400).json({ error: 'invalid' }))
  await request(app).post('/bad').send({ a: 1 })
  const [e] = await entries()
  expect(e.meta.http.req.body).toEqual({ a: 1 })
  expect(e.meta.http.res.body).toEqual({ error: 'invalid' })
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
  expect((await entries())[0].meta.http.res.body).toEqual({ _truncated: true, _bytes: 510 })
})

test('chunked writes are reassembled, and the cap applies mid-stream', async () => {
  const ok = await appWith({ bodies: 'always' })
  const res = await request(ok.app).get('/chunked')
  expect(res.body.a).toHaveLength(100)
  expect((await ok.entries())[0].meta.http.res.body.a).toHaveLength(100)

  const capped = await appWith({ bodies: 'always', maxBodyBytes: 50 })
  const res2 = await request(capped.app).get('/chunked')
  expect(res2.body.a).toHaveLength(100)
  // the same marker shape truncateJson uses, so one LogQL filter catches both
  expect((await capped.entries())[0].meta.http.res.body).toEqual({ _truncated: true, _bytes: 108 })
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
  const { app, entries, state } = await appWith({})
  const server = createServer(app).listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  try {
    const { port } = server.address() as AddressInfo
    const req = httpRequest({ port, host: '127.0.0.1', path: '/hang' })
    req.on('error', () => {})
    req.end()
    await waitFor(() => state.hangHits > 0) // the handler is running and will never answer
    req.destroy()
    let e = await entries()
    for (let i = 0; e.length === 0 && i < 100; i++) {
      await sleep(20)
      e = await entries()
    }
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

test('splits duration into server and transit', async () => {
  const { app, entries } = await appWith({})
  await request(app).get('/slow').expect(200)
  const http = (await entries())[0].meta.http
  expect(http.server_ms).toBeGreaterThanOrEqual(15)
  expect(http.transit_ms).toBeGreaterThanOrEqual(0)
  expect(http.server_ms + http.transit_ms).toBeCloseTo(http.duration_ms, 0)
})

test('a request aborted before any write has no split', async () => {
  const { app, entries, state } = await appWith({})
  const req = request(app).get('/hang').end(() => {})
  await waitFor(() => state.hangHits > 0)
  req.abort()
  let e = await entries()
  for (let i = 0; e.length === 0 && i < 100; i++) {
    await sleep(20)
    e = await entries()
  }
  const http = e[0].meta.http
  expect(http.aborted).toBe(true)
  expect(http.server_ms).toBeUndefined()
  expect(http.transit_ms).toBeUndefined()
  expect(http.duration_ms).toBeGreaterThanOrEqual(0)
})

test('a request through the error handler still has a split', async () => {
  const { app, entries } = await appWith({})
  await request(app).get('/throws').expect(500)
  const http = (await entries())[0].meta.http
  expect(http.server_ms).toBeGreaterThanOrEqual(0)
  expect(http.transit_ms).toBeGreaterThanOrEqual(0)
})

test('a double end() yields non-negative server and transit', async () => {
  const { app, entries } = await appWith({})
  await request(app).get('/double-end').expect(200)
  const http = (await entries())[0].meta.http
  expect(http.transit_ms).toBeGreaterThanOrEqual(0)
  expect(http.server_ms).toBeGreaterThanOrEqual(0)
})

test('the first-byte mark is set once: a gap between first byte and end lands in transit', async () => {
  const { app, entries } = await appWith({})
  await request(app).get('/gap').expect(200)
  const http = (await entries())[0].meta.http
  expect(http.transit_ms).toBeGreaterThanOrEqual(20)
  expect(http.server_ms).toBeLessThan(15)
})

test('a late second end() does not move the mark', async () => {
  const { app, entries } = await appWith({})
  await request(app).get('/double-end-gap').expect(200)
  const http = (await entries())[0].meta.http
  expect(http.server_ms).toBeLessThan(15)
  expect(http.transit_ms).toBeGreaterThanOrEqual(0)
})

test('an explicit writeHead with no body still marks the first byte', async () => {
  const { app, entries } = await appWith({})
  await request(app).get('/head-only').expect(204)
  const http = (await entries())[0].meta.http
  expect(http.server_ms).toBeGreaterThanOrEqual(0)
})

test('writeHead alone marks the first byte, ahead of a gap before end()', async () => {
  const { app, entries } = await appWith({})
  await request(app).get('/head-gap').expect(204)
  const http = (await entries())[0].meta.http
  expect(http.server_ms).toBeLessThan(15)
  expect(http.transit_ms).toBeGreaterThanOrEqual(20)
})

test('an app cannot overwrite the measurement via resolveMeta', async () => {
  const { app, entries } = await appWith({ resolveMeta: () => ({ server_ms: 999999 }) })
  await request(app).get('/users/1').expect(200)
  expect((await entries())[0].meta.http.server_ms).toBeLessThan(999999)
})

test('an unparsed request emits no req.body key at all, on either Express major', async () => {
  const { app, entries } = await appWith({ bodies: 'always' })
  app.post('/noparse', (_req, res) => void res.status(500).end())
  await request(app).post('/noparse').set('Content-Type', 'text/plain').send('hi')
  const [e] = await entries()
  expect('body' in e.meta.http.req).toBe(false)
  expect('body' in e.meta.http.res).toBe(false)
})

test('a healthy capture does not carry body_capture_failed', async () => {
  const { app, entries } = await appWith({ bodies: 'always' })
  await request(app).post('/echo').send({ a: 1 })
  expect('body_capture_failed' in (await entries())[0].meta.http).toBe(false)
})

test('a Buffer request body is never captured', async () => {
  const { app, entries } = await appWith({ bodies: 'always' })
  // What `express.raw()` leaves behind: a Buffer holding an unparsed JSON document.
  app.post(
    '/raw',
    (req, _res, next) => {
      req.body = Buffer.from('{"a":1,"password":"hunter2"}')
      next()
    },
    (_req, res) => void res.status(500).end(),
  )
  await request(app).post('/raw').set('Content-Type', 'application/octet-stream').send('x')
  const [e] = await entries()
  expect(JSON.stringify(e)).not.toContain('hunter2')
  // Express 4's json parser leaves `req.body = {}` where Express 5 leaves it undefined: an
  // empty object carries nothing, so the contract is "no content", not "no key".
  expect(e.meta.http.req.body ?? {}).toEqual({})
  expect(JSON.stringify(e.meta.http.req)).not.toContain('"a"')
})

test('a streamed, unparsed request body is never captured', async () => {
  const { app, entries } = await appWith({ bodies: 'always' })
  app.post('/upload', (req, res) => {
    req.resume()
    req.on('end', () => void res.status(500).end())
  })
  await request(app).post('/upload').set('Content-Type', 'text/plain').send('password=hunter2')
  const [e] = await entries()
  expect(e.meta.http.req.body ?? {}).toEqual({}) // `{}` on Express 4, see above
  expect(JSON.stringify(e)).not.toContain('hunter2')
})

test('log() honours kind from any caller, by design', async () => {
  const { log, entries } = await appWith({})
  log.log('info', 'x', { kind: 'request' })
  const [e] = await entries()
  expect(e.kind).toBe('request')
})

test('a req.body getter that throws costs the bodies, never the line', async () => {
  const { app, entries } = await appWith({ bodies: 'always' })
  app.get(
    '/hostile',
    (req, _res, next) => {
      Object.defineProperty(req, 'body', {
        get() {
          throw new Error('nope')
        },
      })
      next()
    },
    (_req, res) => void res.status(500).json({ error: 'x' }),
  )
  await request(app).get('/hostile').expect(500)
  const e = await entries()
  expect(e).toHaveLength(1)
  expect(e[0].meta.http).toMatchObject({ route: '/hostile', status: 500 })
  expect('body' in e[0].meta.http.req).toBe(false)
  expect(e[0].meta.http.body_capture_failed).toBe(true)
})

/** Raw response bytes, so a test can compare exactly what the client received. */
const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void): void => {
  const parts: Buffer[] = []
  res.on('data', (c: Buffer) => parts.push(c))
  res.on('end', () => cb(null, Buffer.concat(parts)))
}

describe('response wrapping leaves the response intact', () => {
  test('res.write with an explicit encoding (hex): bytes sent and body captured agree', async () => {
    const { app, entries } = await appWith({ bodies: 'always' })
    const json = Buffer.from('{"a":"\u00e9"}', 'utf8')
    app.get('/hex', (_req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.write(json.toString('hex'), 'hex')
      res.end()
    })
    const res = await request(app).get('/hex').buffer(true).parse(binary)
    expect(res.body).toEqual(json)
    expect((await entries())[0].meta.http.res.body).toEqual({ a: '\u00e9' })
  })

  test('res.write with a callback argument still calls it', async () => {
    const { app, entries } = await appWith({ bodies: 'always' })
    let called = false
    app.get('/cb', (_req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.write('{"a":1}', () => {
        called = true
      })
      res.end()
    })
    const res = await request(app).get('/cb')
    expect(res.body).toEqual({ a: 1 })
    expect(called).toBe(true)
    expect((await entries())[0].meta.http.res.body).toEqual({ a: 1 })
  })

  test('write() backpressure (false) is passed through to the caller', async () => {
    const { app } = await appWith({ bodies: 'always' })
    let ret: boolean | undefined
    app.get('/bp', (_req, res) => {
      res.setHeader('Content-Type', 'application/json')
      ret = res.write('{"pad":"' + 'x'.repeat(1_000_000))
      res.end('"}')
    })
    const res = await request(app).get('/bp')
    expect(res.body.pad).toHaveLength(1_000_000)
    expect(ret).toBe(false)
  })

  test('a piped response is delivered whole and its JSON body captured', async () => {
    const { app, entries } = await appWith({ bodies: 'always' })
    app.get('/piped', (_req, res) => {
      res.setHeader('Content-Type', 'application/json')
      Readable.from(['{"a":', '1,', '"b":2}']).pipe(res)
    })
    const res = await request(app).get('/piped')
    expect(res.body).toEqual({ a: 1, b: 2 })
    expect((await entries())[0].meta.http.res.body).toEqual({ a: 1, b: 2 })
  })

  test('behind compression: the client gets the right bytes and no body is captured', async () => {
    // A small cap against a large payload: if the content-encoding skip were removed, the
    // compressed bytes would overflow it and a `_truncated` marker would appear.
    const { app, entries } = await appWith({ bodies: 'always', maxBodyBytes: 64 })
    const payload = { pad: randomBytes(1000).toString('hex') } // incompressible, so gzip output exceeds the cap
    app.get('/zip', compression({ threshold: 0 }), (_req, res) => void res.json(payload))
    const res = await request(app).get('/zip').set('Accept-Encoding', 'gzip')
    expect(res.headers['content-encoding']).toBe('gzip')
    expect(res.body).toEqual(payload) // supertest inflated what the middleware let through
    const [e] = await entries()
    expect(e.meta.http.status).toBe(200)
    expect('body' in e.meta.http.res).toBe(false)
  })

  test('a buffer the application reuses after writing does not alter the captured body', async () => {
    const { app, entries } = await appWith({ bodies: 'always' })
    app.get('/reuse', (_req, res) => {
      const b = Buffer.from('{"a":"x"')
      res.setHeader('Content-Type', 'application/json')
      res.write(b)
      b.fill('y')
      res.end('}')
    })
    await request(app).get('/reuse').buffer(true).parse(binary)
    expect((await entries())[0].meta.http.res.body).toEqual({ a: 'x' })
  })
})

test('ordinary log calls never carry kind, even if one is smuggled in', async () => {
  const { log, entries } = await appWith({})
  log.info('plain')
  log.warn('plain2', { kind: 'request' } as never)
  const e = await entries()
  expect(e).toHaveLength(2)
  for (const x of e) expect('kind' in x).toBe(false)
})

test('phases recorded during a request reach meta.http.timings', async () => {
  const { app, entries, log } = await appWith({})
  app.get('/phased', async (_req, res) => {
    await log.time('db', () => sleep(20))
    await log.time('render', () => sleep(5))
    res.json({ ok: true })
  })
  await request(app).get('/phased').expect(200)
  const http = (await entries()).at(-1)!.meta.http
  expect(Object.keys(http.timings).sort()).toEqual(['db', 'render'])
  expect(http.timings.db).toBeGreaterThanOrEqual(15)
  expect(http.timings.render).toBeGreaterThanOrEqual(0)
  expect(http.timings.server).toBeUndefined() // reserved, never a phase
  expect(http.timings.transit).toBeUndefined()
  expect(typeof http.server_ms).toBe('number') // the split stays scalar
})

test('a phase recorded without req, from a nested function, is still attributed', async () => {
  const { app, entries, log } = await appWith({})
  const repo = () => log.time('db', () => sleep(20)) // takes no req
  app.get('/nested', async (_req, res) => {
    await repo()
    res.json({ ok: true })
  })
  await request(app).get('/nested').expect(200)
  expect((await entries()).at(-1)!.meta.http.timings.db).toBeGreaterThanOrEqual(15)
})

test('concurrent requests keep their phases apart', async () => {
  const { app, entries, log } = await appWith({})
  app.get('/c/:name', async (req, res) => {
    await log.time(req.params.name, () => sleep(10))
    res.json({ ok: true })
  })
  await Promise.all([request(app).get('/c/aaa'), request(app).get('/c/bbb')])
  const keys = (await entries()).map((e) => Object.keys(e.meta.http.timings).join()).sort()
  expect(keys).toEqual(['aaa', 'bbb'])
})

test('a child logger records into the same request', async () => {
  const { app, entries, log } = await appWith({})
  const child = log.child({ dims: { part: 'x' } })
  app.get('/child', async (_req, res) => {
    await child.time('db', () => sleep(5))
    res.json({ ok: true })
  })
  await request(app).get('/child').expect(200)
  expect((await entries()).at(-1)!.meta.http.timings.db).toBeGreaterThanOrEqual(0)
})

test('logger.phase records on the returned stop function, once', async () => {
  const { app, entries, log } = await appWith({})
  app.get('/manual', async (_req, res) => {
    const stop = log.phase('cache')
    await sleep(15)
    stop()
    stop()
    res.json({ ok: true })
  })
  await request(app).get('/manual').expect(200)
  const t = (await entries()).at(-1)!.meta.http.timings
  expect(t.cache).toBeGreaterThanOrEqual(10)
  expect(t.cache).toBeLessThan(200)
})

test('time returns the callback value and rethrows its error', async () => {
  const { app, entries, log } = await appWith({})
  let value: unknown
  let thrown: unknown
  app.get('/vals', (_req, res) => {
    value = log.time('sync', () => 42)
    try {
      log.time('bad', () => {
        throw new Error('nope')
      })
    } catch (e) {
      thrown = e
    }
    res.json({ ok: true })
  })
  await request(app).get('/vals').expect(200)
  expect(value).toBe(42)
  expect((thrown as Error).message).toBe('nope')
  expect(Object.keys((await entries()).at(-1)!.meta.http.timings).sort()).toEqual(['bad', 'sync'])
})

test('timings is absent when the app records no phase', async () => {
  const { app, entries } = await appWith({})
  await request(app).get('/users/1').expect(200)
  expect('timings' in (await entries())[0].meta.http).toBe(false)
})

test('a phase outside any request does not throw and is not attributed', async () => {
  const { app, entries, log } = await appWith({})
  await expect(log.time('orphan', () => sleep(1))).resolves.toBeUndefined() // no request in flight
  log.phase('orphan2')()
  await request(app).get('/users/1').expect(200)
  expect('timings' in (await entries())[0].meta.http).toBe(false)
})

test('resolveMeta timings and recorded phases both survive, recorded winning a collision', async () => {
  const { app, entries, log } = await appWith({ resolveMeta: () => ({ timings: { auth: 7, db: 9999 } }) })
  app.get('/both', async (_req, res) => {
    await log.time('db', () => sleep(10))
    res.json({ ok: true })
  })
  await request(app).get('/both').expect(200)
  const t = (await entries()).at(-1)!.meta.http.timings
  expect(t.db).toBeGreaterThanOrEqual(5)
  expect(t.db).toBeLessThan(9999)
  expect(t.auth).toBe(7)
})

test('reserved names are dropped from resolveMeta timings on both merge paths', async () => {
  const { app, entries, log } = await appWith({
    resolveMeta: () => ({ timings: { server: 50, transit: 9, db: 40 } }),
  })
  app.get('/both-reserved', async (_req, res) => {
    await log.time('cache', () => sleep(5))
    res.json({ ok: true })
  })
  await request(app).get('/users/1').expect(200) // no recorded phases: the hasOwn path
  await request(app).get('/both-reserved').expect(200) // recorded phases: the explicit merge
  const [plain, merged] = await entries()
  expect(plain.meta.http.timings).toEqual({ db: 40 })
  expect(Object.keys(merged.meta.http.timings).sort()).toEqual(['cache', 'db'])
})

test('resolveMeta timings pass through untouched when no phase was recorded', async () => {
  const { app, entries } = await appWith({ resolveMeta: () => ({ timings: { auth: 7 } }) })
  await request(app).get('/users/1').expect(200)
  expect((await entries())[0].meta.http.timings).toEqual({ auth: 7 })
})

const flagsOf = (e: any): string[] => e.meta.http.flags ?? []

test('a CORS preflight is flagged', async () => {
  const { app, entries } = await appWith({})
  await request(app).options('/users/1').set('Origin', 'https://example.com').set('Access-Control-Request-Method', 'GET')
  expect(flagsOf((await entries())[0])).toEqual(['preflight'])
})

test('a plain OPTIONS is not flagged', async () => {
  const { app, entries } = await appWith({})
  await request(app).options('/users/1')
  expect(flagsOf((await entries())[0])).not.toContain('preflight')
})

test('OPTIONS with an Origin but no Access-Control-Request-Method is not flagged', async () => {
  const { app, entries } = await appWith({})
  await request(app).options('/users/1').set('Origin', 'https://example.com')
  expect(flagsOf((await entries())[0])).not.toContain('preflight')
})

test('OPTIONS with Access-Control-Request-Method but no Origin is not flagged', async () => {
  const { app, entries } = await appWith({})
  await request(app).options('/users/1').set('Access-Control-Request-Method', 'GET')
  expect(flagsOf((await entries())[0])).not.toContain('preflight')
})

test('a GET carrying both CORS headers is not flagged', async () => {
  const { app, entries } = await appWith({})
  await request(app)
    .get('/users/1')
    .set('Origin', 'https://example.com')
    .set('Access-Control-Request-Method', 'GET')
    .expect(200)
  expect(flagsOf((await entries())[0])).not.toContain('preflight')
})

test("an app's own flags survive alongside the preflight flag", async () => {
  const { app, entries } = await appWith({ resolveMeta: () => ({ flags: ['ip-exc'] }) })
  await request(app).options('/users/1').set('Origin', 'https://example.com').set('Access-Control-Request-Method', 'GET')
  expect(flagsOf((await entries())[0])).toEqual(['ip-exc', 'preflight'])
})

test('a preflight flag the app also supplies is not duplicated', async () => {
  const { app, entries } = await appWith({ resolveMeta: () => ({ flags: ['preflight'] }) })
  await request(app).options('/users/1').set('Origin', 'https://example.com').set('Access-Control-Request-Method', 'GET')
  expect(flagsOf((await entries())[0])).toEqual(['preflight'])
})

test("an app's flags pass through untouched when the request is not a preflight", async () => {
  const { app, entries } = await appWith({ resolveMeta: () => ({ flags: ['ip-exc'] }) })
  await request(app).options('/users/1')
  expect(flagsOf((await entries())[0])).toEqual(['ip-exc'])
})

test('preflights still count as requests', async () => {
  const { app, entries } = await appWith({})
  await request(app).options('/users/1').set('Origin', 'https://e.com').set('Access-Control-Request-Method', 'GET')
  const e = (await entries())[0]
  expect(e.kind).toBe('request')
  expect(e.meta.http.method).toBe('OPTIONS')
})
})
