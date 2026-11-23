import { createLogger } from '../src/logger'
import { createSink } from '../src/sink'
import { createStubGateway, type StubGateway, type StubGatewayOptions } from './helpers/stub-gateway'
import { base, sleep, tmp, waitFor } from './helpers/fixtures'
import type { LoggerOptions } from '../src/types'
import fs from 'node:fs'
import path from 'node:path'

const gateways: StubGateway[] = []
const closeables: Array<{ close(): Promise<void> }> = []

/** Registers a gateway for teardown so no suite leaves a listening socket behind. */
async function gateway(opts?: StubGatewayOptions): Promise<StubGateway> {
  const g = await createStubGateway(opts)
  gateways.push(g)
  return g
}

function track<T extends { close(): Promise<void> }>(c: T): T {
  closeables.push(c)
  return c
}

afterEach(async () => {
  for (const c of closeables.splice(0)) await c.close()
  for (const g of gateways.splice(0)) await g.close()
})

const opts = (o: Partial<LoggerOptions> & { url: string }): LoggerOptions => ({ ...base, ...o })

test('level methods stamp level, timestamp and configured dims', async () => {
  const g = await gateway()
  const log = track(createLogger(opts({ url: g.url, dims: { company_id: 'acme' } })))
  log.info('hello', { dims: { user_id: 'u1' } })
  await log.flush()
  const e = g.batches[0].entries[0]
  expect(e).toMatchObject({ level: 'info', msg: 'hello',
                            dims: { company_id: 'acme', user_id: 'u1' } })
  expect(Date.parse(e.ts)).toBeGreaterThan(0)
})

test('child merges dims and does not mutate the parent', async () => {
  const g = await gateway()
  const log = track(createLogger(opts({ url: g.url, dims: { company_id: 'acme' } })))
  log.child({ dims: { user_id: 'u1' } }).info('a')
  log.info('b')
  await log.flush()
  const [a, b] = g.batches.flatMap((x) => x.entries)
  expect(a.dims).toEqual({ company_id: 'acme', user_id: 'u1' })
  expect(b.dims).toEqual({ company_id: 'acme' })
})

test('never throws into application code when the gateway is unreachable', async () => {
  const log = createLogger(opts({ url: 'ws://127.0.0.1:1/none', spool: { dir: tmp() }, onError: () => {} }))
  expect(() => log.info('still fine')).not.toThrow()
  await log.close()
})

test('coerces an unknown level to info', async () => {
  const g = await gateway()
  const log = track(createLogger(opts({ url: g.url })))
  log.log('verbose', 'x')
  await log.flush()
  expect(g.batches[0].entries[0].level).toBe('info')
})

test('createSink accepts raw entries for a pino or winston adapter', async () => {
  const g = await gateway()
  const sink = createSink(opts({ url: g.url }))
  sink.write({ ts: new Date().toISOString(), level: 'warn', msg: 'from pino' })
  await sink.flush()
  expect(g.batches[0].entries[0]).toMatchObject({ level: 'warn', msg: 'from pino' })
  await sink.close()
})

test('redacts before anything reaches the wire', async () => {
  const g = await gateway()
  const log = track(createLogger(opts({ url: g.url })))
  log.info('login', { meta: { body: { password: 'hunter2' } } })
  await log.flush()
  expect(JSON.stringify(g.batches)).not.toContain('hunter2')
})

test('every level method stamps its own level', async () => {
  const g = await gateway()
  const log = track(createLogger(opts({ url: g.url })))
  for (const level of ['debug', 'info', 'warn', 'error', 'fatal'] as const) log[level](level)
  await log.flush()
  const entries = g.batches.flatMap((b) => b.entries)
  expect(entries.map((e) => [e.level, e.msg])).toEqual([
    ['debug', 'debug'], ['info', 'info'], ['warn', 'warn'], ['error', 'error'], ['fatal', 'fatal'],
  ])
})

test('batch ids are sortable ULIDs', async () => {
  const g = await gateway()
  const log = track(createLogger(opts({ url: g.url })))
  log.info('one')
  await log.flush()
  log.info('two')
  await log.flush()
  const [a, b] = g.batches.map((x) => x.id)
  expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  expect(b > a).toBe(true)
})

test("the server's hello lowers the batcher's cut size", async () => {
  const g = await gateway({ hello: { maxEntriesPerBatch: 2 } })
  const log = track(createLogger(opts({ url: g.url })))
  log.info('open the stream')
  await log.flush()            // guarantees hello has been processed
  log.info('a'); log.info('b'); log.info('c')
  await log.flush()
  expect(g.batches[1].entries.map((e) => e.msg)).toEqual(['a', 'b'])
  expect(g.batches[2].entries.map((e) => e.msg)).toEqual(['c'])
})

test('a zero in hello does not stall the batcher', async () => {
  const g = await gateway({ hello: { maxEntriesPerBatch: 0 } })
  const log = track(createLogger(opts({ url: g.url })))
  log.info('first')
  await log.flush()
  log.info('second')
  await log.flush()
  expect(g.batches.flatMap((b) => b.entries).map((e) => e.msg)).toEqual(['first', 'second'])
})

test('reports the batcher drop count once, on the next batch', async () => {
  const g = await gateway()
  const log = track(createLogger(opts({ url: g.url, batch: { maxQueue: 2 } })))
  for (const m of ['a', 'b', 'c', 'd', 'e']) log.info(m)
  await log.flush()
  expect(g.batches[0].droppedSinceLast).toBe(3)
  expect(g.batches[0].prunedBatchesSinceLast).toBeUndefined()   // entries, not batches
  log.info('f')
  await log.flush()
  expect(g.batches[1].droppedSinceLast ?? 0).toBe(0)
})

test('a log call after close is dropped, not thrown', async () => {
  const g = await gateway()
  const log = createLogger(opts({ url: g.url }))
  log.info('before close')
  await log.close()
  expect(() => log.info('after close')).not.toThrow()
  await sleep(20)
  expect(g.batches.flatMap((b) => b.entries).map((e) => e.msg)).toEqual(['before close'])
})

test('close is idempotent', async () => {
  const g = await gateway()
  const log = createLogger(opts({ url: g.url }))
  log.info('x')
  const first = log.close()
  await expect(Promise.all([first, log.close(), log.close()])).resolves.toHaveLength(3)
  expect(g.batches).toHaveLength(1)
})

test("closing a child does not close its parent's stream", async () => {
  const g = await gateway()
  const log = track(createLogger(opts({ url: g.url })))
  const child = log.child({ dims: { user_id: 'u1' } })
  await child.close()
  log.info('parent still works')
  await log.flush()
  expect(g.batches.flatMap((b) => b.entries).map((e) => e.msg)).toEqual(['parent still works'])
})

test('rate-limits a repeating cause so a persistent failure cannot spam onError', async () => {
  const seen: Error[] = []
  const g = await gateway()
  const log = track(createLogger(opts({ url: g.url, onError: (e) => seen.push(e) })))
  log.info('open the stream')
  await log.flush()
  for (let i = 0; i < 5; i++) g.conns[0].sendRaw('{not json')
  await waitFor(() => seen.length > 0)
  await sleep(50)
  expect(seen.filter((e) => /malformed/.test(e.message))).toHaveLength(1)
})

test('the default error hook warns at most once per interval', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const g = await gateway()
    // Two unrelated causes within one interval: an unusable spool, then a malformed frame.
    const root = tmp()
    fs.writeFileSync(path.join(root, 'blocked'), 'x')
    const log = track(createLogger({ url: g.url, apiKey: 'k', service: 'public-api', env: 'test',
                                     spool: { dir: path.join(root, 'blocked', 'spool') } }))
    await waitFor(() => warn.mock.calls.length > 0)
    log.info('open the stream')
    await log.flush()
    g.conns[0].sendRaw('{not json')
    await sleep(50)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('logguber')
  } finally {
    warn.mockRestore()
  }
})

test('an unusable spool directory leaves a working memory-only logger', async () => {
  const seen: Error[] = []
  const g = await gateway()
  // A plain file where the spool wants a directory: mkdir fails, so the spool is unavailable.
  const root = tmp()
  fs.writeFileSync(path.join(root, 'blocked'), 'x')
  const log = track(createLogger(opts({ url: g.url, spool: { dir: path.join(root, 'blocked', 'spool') },
                                        onError: (e) => seen.push(e) })))
  log.info('memory only')
  await log.flush()
  expect(g.batches[0].entries[0].msg).toBe('memory only')
  expect(seen.length).toBeGreaterThan(0)
})
