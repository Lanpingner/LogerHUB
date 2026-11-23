import { createStubGateway, type StubGateway } from './helpers/stub-gateway'
import { base, batch, sleep, waitFor } from './helpers/fixtures'
import { buildTransport, createTransport, type Transport, type TransportHooks } from '../src/transport'

const gateways: StubGateway[] = []
const transports: Transport[] = []

async function gateway(opts?: Parameters<typeof createStubGateway>[0]): Promise<StubGateway> {
  const g = await createStubGateway(opts)
  gateways.push(g)
  return g
}
function transport(opts: Parameters<typeof createTransport>[0], hooks: TransportHooks = {}): Transport {
  const t = buildTransport(opts, hooks)
  transports.push(t)
  return t
}

afterEach(async () => {
  await Promise.all(transports.splice(0).map((t) => t.close()))
  await Promise.all(gateways.splice(0).map((g) => g.close()))
})

const noop = () => {}
const handlers = { onAck: noop, onNack: noop, onState: noop }

test('sends service, env and bearer key on the handshake', async () => {
  const g = await gateway()
  const t = transport({ ...base, ...handlers, url: g.url })
  await waitFor(() => t.state() === 'open')
  const req = g.conns[0].request
  expect(req.url).toContain('service=public-api')
  expect(req.url).toContain('env=test')
  expect(req.headers.authorization).toBe('Bearer lgb_test_secret')
})

test('refuses to send beyond the ack window until acks arrive', async () => {
  const g = await gateway({ hello: { ackWindow: 2 }, onBatch: () => {} }) // never acks
  const t = transport({ ...base, ...handlers, url: g.url })
  await waitFor(() => t.state() === 'open')
  expect(t.send(batch('1'))).toBe(true)
  expect(t.send(batch('2'))).toBe(true)
  expect(t.send(batch('3'))).toBe(false)
  expect(t.inFlight()).toBe(2)
})

test('frees the slot when an ack arrives', async () => {
  const g = await gateway() // acks everything
  const onAck = vi.fn()
  const t = transport({ ...base, ...handlers, onAck, url: g.url })
  await waitFor(() => t.state() === 'open')
  t.send(batch('1'))
  await waitFor(() => t.inFlight() === 0)
  expect(onAck).toHaveBeenCalledWith('1')
})

test('treats 4401 and 4403 as fatal and stops reconnecting', async () => {
  for (const code of [4401, 4403]) {
    const g = await gateway({ rejectWith: code })
    const onState = vi.fn()
    const onError = vi.fn()
    const t = transport({ ...base, ...handlers, onState, onError, url: g.url, backoff: { baseMs: 5, maxMs: 5 } })
    await waitFor(() => t.state() === 'fatal')
    const attempts = g.conns.length
    await sleep(200)
    expect(g.conns.length).toBe(attempts) // no further attempts
    expect(onState).toHaveBeenLastCalledWith('fatal')
    expect(onError).toHaveBeenCalled()
  }
})

test('reconnects with backoff after a transient close', async () => {
  const g = await gateway()
  const t = transport({ ...base, ...handlers, url: g.url, backoff: { baseMs: 10, maxMs: 50 } })
  await waitFor(() => t.state() === 'open')
  await g.stop()
  await waitFor(() => t.state() !== 'open')
  await g.start()
  await waitFor(() => t.state() === 'open', 3000)
})

// Review Focus: a batch the gateway never acks must not leak its in-flight slot
test('reclaims the slot when an ack never arrives', async () => {
  const g = await gateway({ hello: { ackWindow: 1 }, onBatch: () => {} })
  const onNack = vi.fn()
  const t = transport({ ...base, ...handlers, onNack, url: g.url, ackTimeoutMs: 50 })
  await waitFor(() => t.state() === 'open')
  expect(t.send(batch('1'))).toBe(true)
  expect(t.send(batch('2'))).toBe(false)
  await waitFor(() => t.inFlight() === 0, 1000) // timed out and released
  expect(onNack).toHaveBeenCalledWith({ t: 'nack', id: '1', reason: 'ack timeout', retryable: true })
  expect(t.send(batch('2'))).toBe(true)
})

test('reports a non-retryable nack without reconnecting', async () => {
  const g = await gateway({
    onBatch: (b, c) => c.send({ t: 'nack', id: b.id, reason: 'malformed', retryable: false }),
  })
  const onNack = vi.fn()
  const t = transport({ ...base, ...handlers, onNack, url: g.url })
  await waitFor(() => t.state() === 'open')
  t.send(batch('1'))
  await waitFor(() => onNack.mock.calls.length === 1)
  expect(onNack.mock.calls[0][0].retryable).toBe(false)
  expect(t.state()).toBe('open')
  expect(t.inFlight()).toBe(0)
  expect(g.conns.length).toBe(1)
})

test('send is refused while connecting (no gateway yet)', async () => {
  const g = await gateway()
  await g.stop()
  const t = transport({ ...base, ...handlers, url: g.url, backoff: { baseMs: 5, maxMs: 10 } })
  expect(t.send(batch('1'))).toBe(false)
  expect(t.inFlight()).toBe(0)
})

test('ignores acks for unknown or already-acked ids, malformed JSON and unknown frame types', async () => {
  const g = await gateway({ onBatch: () => {} })
  const onAck = vi.fn()
  const onError = vi.fn()
  const t = transport({ ...base, ...handlers, onAck, onError, url: g.url })
  await waitFor(() => t.state() === 'open')
  t.send(batch('1'))
  const c = g.conns[0]
  c.send({ t: 'ack', id: 'never-sent' })
  c.sendRaw('{not json')
  c.sendRaw(JSON.stringify({ t: 'mystery' }))
  c.send({ t: 'ack', id: '1' })
  c.send({ t: 'ack', id: '1' }) // duplicate
  await waitFor(() => onError.mock.calls.length === 1)
  await sleep(30)
  expect(onAck.mock.calls).toEqual([['1']])
  expect(t.inFlight()).toBe(0)
  expect(t.state()).toBe('open')
})

test('a drop with batches in flight releases their slots and nacks them as retryable', async () => {
  const g = await gateway({ hello: { ackWindow: 2 }, onBatch: () => {} })
  const onNack = vi.fn()
  const t = transport({ ...base, ...handlers, onNack, url: g.url, backoff: { baseMs: 5, maxMs: 10 } })
  await waitFor(() => t.state() === 'open')
  t.send(batch('1'))
  t.send(batch('2'))
  await waitFor(() => g.batches.length === 2)
  g.conns[0].closeWith(1011)
  await waitFor(() => onNack.mock.calls.length === 2)
  expect(onNack.mock.calls.map((c) => c[0].id).sort()).toEqual(['1', '2'])
  expect(onNack.mock.calls.every((c) => c[0].retryable === true)).toBe(true)
  await waitFor(() => t.state() === 'open') // reconnected with a clean window
  expect(t.inFlight()).toBe(0)
  expect(t.send(batch('3'))).toBe(true)
})

test('one failed connect counts as one attempt: backoff grows once per failure and resets on success', async () => {
  const g = await gateway()
  await g.stop()
  const delays: number[] = []
  const t = transport({
    ...base,
    ...handlers,
    url: g.url,
    backoff: { baseMs: 10, maxMs: 1000 },
  }, {
    random: () => 1, // full jitter at its ceiling makes the delay observable
    onBackoff: (ms) => delays.push(ms),
  })
  await waitFor(() => delays.length >= 3)
  expect(delays.slice(0, 3)).toEqual([10, 20, 40]) // error + close did not double count
  await g.start()
  await waitFor(() => t.state() === 'open', 3000)
  await g.stop()
  await waitFor(() => delays.length >= 4)
  expect(delays[delays.length - 1]).toBe(10) // reset after the successful open
})

test('fatal clears the reconnect timer and close() afterwards is safe', async () => {
  const g = await gateway({ rejectWith: 4403 })
  const t = transport({ ...base, ...handlers, url: g.url })
  await waitFor(() => t.state() === 'fatal')
  await t.close()
  await t.close()
  expect(t.state()).toBe('fatal')
})

test('close() is final: idempotent, cancels a pending reconnect, refuses sends', async () => {
  const g = await gateway()
  const t = transport({ ...base, ...handlers, url: g.url, backoff: { baseMs: 20, maxMs: 20 } })
  await waitFor(() => t.state() === 'open')
  await g.stop()
  await waitFor(() => t.state() !== 'open')
  await Promise.all([t.close(), t.close()])
  expect(t.state()).toBe('closed')
  await g.start()
  await sleep(100)
  expect(g.conns.length).toBe(1) // never reconnected
  expect(t.state()).toBe('closed')
  expect(t.send(batch('1'))).toBe(false)
})

test('close() while open tears the socket down', async () => {
  const g = await gateway()
  const t = transport({ ...base, ...handlers, url: g.url })
  await waitFor(() => t.state() === 'open')
  await t.close()
  expect(t.state()).toBe('closed')
  await waitFor(() => g.conns[0].closed)
})

test('never throws into the app when any callback throws, including onError', async () => {
  const boom = () => { throw new Error('boom') }
  const g = await gateway({ onBatch: (b, c) => c.send({ t: 'nack', id: b.id, reason: 'x', retryable: false }) })
  const t = transport({ ...base, url: g.url, onAck: boom, onNack: boom, onState: boom, onError: boom, onHello: boom })
  await waitFor(() => t.state() === 'open')
  t.send(batch('1'))
  await waitFor(() => t.inFlight() === 0) // onNack threw but the slot was released
  g.conns[0].sendRaw('{bad') // drives onError, which throws
  await sleep(30)
  expect(t.state()).toBe('open')
  await g.stop() // transient close drives onNack/onState/onError throwing paths
  await waitFor(() => t.state() !== 'open')
})

test('onHello receives the server limits, before state open is reported', async () => {
  const g = await gateway({ hello: { ackWindow: 3, maxEntriesPerBatch: 77, maxBatchBytes: 999 } })
  const order: string[] = []
  const onHello = vi.fn(() => { order.push('hello') })
  const t = transport({ ...base, ...handlers, onHello, onState: (s) => order.push(s), url: g.url })
  await waitFor(() => t.state() === 'open')
  expect(onHello).toHaveBeenCalledWith({ t: 'hello', ackWindow: 3, maxEntriesPerBatch: 77, maxBatchBytes: 999 })
  expect(order.indexOf('hello')).toBeLessThan(order.indexOf('open'))
})

test('inFlightBatches returns sent-but-unacked batches and empties on ack', async () => {
  const g = await gateway({ onBatch: () => {} })
  const t = transport({ ...base, ...handlers, url: g.url })
  await waitFor(() => t.state() === 'open')
  const b1 = batch('1'), b2 = batch('2')
  t.send(b1); t.send(b2)
  expect(t.inFlightBatches()).toEqual([b1, b2])
  g.conns[0].send({ t: 'ack', id: '1' })
  await waitFor(() => t.inFlight() === 1)
  expect(t.inFlightBatches()).toEqual([b2])
  g.conns[0].send({ t: 'ack', id: '2' })
  await waitFor(() => t.inFlight() === 0)
  expect(t.inFlightBatches()).toEqual([])
})
