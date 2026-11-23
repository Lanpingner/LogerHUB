import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createLogger } from '../src/logger'
import { createSpool } from '../src/spool'
import { createStubGateway, type StubGateway, type StubGatewayOptions } from './helpers/stub-gateway'
import { base, sleep, tmp, waitFor } from './helpers/fixtures'
import type { LoggerOptions } from '../src/types'

const gateways: StubGateway[] = []
const closeables: Array<{ close(): Promise<void> }> = []

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

// These tests take a gateway away and give it back within a second or two. The product's
// reconnect ceiling is the transport's 30s, which is right for a real outage and far too slow
// here, so each logger configures its own short ceiling.
const opts = (o: Partial<LoggerOptions> & { url: string }): LoggerOptions => ({
  ...base,
  backoff: { baseMs: 50, maxMs: 250 },
  ...o,
})

/** One long-lived reader on the spool file: WAL lets it see the logger's commits. */
function spoolRows(dir: string): { count(): number; close(): void } {
  const db = new DatabaseSync(path.join(dir, 'spool.db'))
  const st = db.prepare('select count(*) c from spool')
  return { count: () => Number((st.get() as { c: number }).c), close: () => db.close() }
}

test('an outage costs delay, not logs', async () => {
  const dir = tmp()
  const g = await gateway()
  const log = track(createLogger(opts({ url: g.url, spool: { dir } })))
  log.info('before'); await log.flush()

  const rows = spoolRows(dir)
  try {
    await g.stop()                                   // gateway dies mid-stream
    for (let i = 0; i < 50; i++) log.info(`during-${i}`)
    await waitFor(() => rows.count() > 0)

    await g.start()                                  // gateway returns
    await waitFor(() => g.batches.flatMap((b) => b.entries).length >= 51, 5000)

    const msgs = g.batches.flatMap((b) => b.entries).map((e) => e.msg)
    expect(new Set(msgs).size).toBe(msgs.length)     // exactly once, no duplicates
    for (let i = 0; i < 50; i++) expect(msgs).toContain(`during-${i}`)
    await waitFor(() => rows.count() === 0)
  } finally {
    rows.close()
  }
  await log.close()
})

test('redacted secrets never appear in the on-disk spool', async () => {
  const dir = tmp()
  const log = createLogger(opts({ url: 'ws://127.0.0.1:1/none', spool: { dir }, onError: () => {} }))
  log.info('login', { meta: { body: { password: 'hunter2' } } })
  await log.flush()
  await log.close()                                  // checkpoints the WAL into spool.db
  for (const f of ['spool.db', 'spool.db-wal']) {
    const p = path.join(dir, f)
    if (fs.existsSync(p)) expect(fs.readFileSync(p, 'utf8')).not.toContain('hunter2')
  }
  const s = createSpool({ dir })
  expect(JSON.stringify(s.claim(10))).not.toContain('hunter2')
  s.close()
})

test('close drains undelivered entries to the spool so the next process sends them', async () => {
  const dir = tmp()
  const log = createLogger(opts({ url: 'ws://127.0.0.1:1/none', spool: { dir }, onError: () => {} }))
  log.info('pending'); await log.close()
  const s = createSpool({ dir })
  expect(s.count()).toBeGreaterThan(0)
  s.close()
})

test('close spools a batch that was sent but never acked', async () => {
  const dir = tmp()
  let acked = 0
  // Acks the batch that opens the stream, then goes silent: the second batch is sent from
  // memory and never acknowledged, so only close() can make it durable.
  const g = await gateway({ onBatch: (b, c) => { if (acked++ === 0) c.send({ t: 'ack', id: b.id }) } })
  const log = createLogger(opts({ url: g.url, spool: { dir } }))
  log.info('opens the stream'); await log.flush()
  log.info('in flight'); await log.close()
  const s = createSpool({ dir })
  expect(s.claim(10).flatMap((c) => c.batch.entries).map((e) => e.msg)).toEqual(['in flight'])
  s.close()
})

test('mode always writes to the spool before sending', async () => {
  const dir = tmp()
  const g = await gateway({ onBatch: () => {} })     // never acks
  const log = track(createLogger(opts({ url: g.url, spool: { dir, mode: 'always' } })))
  log.info('durable'); await log.flush()
  const s = createSpool({ dir })
  expect(s.count()).toBe(1)
  s.close()
  expect(g.batches.length).toBe(1)                   // sent once, not retried in a loop
})

test('a retryable nack returns the batch to the spool without a resend storm', async () => {
  const dir = tmp()
  const g = await gateway({ onBatch: (b, c) => c.send({ t: 'nack', id: b.id, reason: 'overloaded', retryable: true }) })
  const log = track(createLogger(opts({ url: g.url, spool: { dir } })))
  log.info('try me later'); await log.flush()
  const s = createSpool({ dir })
  expect(s.count()).toBe(1)
  s.close()
  expect(g.batches.length).toBeLessThan(5)
})

test('a non-retryable nack is discarded rather than spooled', async () => {
  const dir = tmp()
  const g = await gateway({ onBatch: (b, c) => c.send({ t: 'nack', id: b.id, reason: 'invalid', retryable: false }) })
  const log = track(createLogger(opts({ url: g.url, spool: { dir } })))
  log.info('hopeless'); await log.flush()
  await sleep(50)
  const s = createSpool({ dir })
  expect(s.count()).toBe(0)
  s.close()
  expect(g.batches.length).toBe(1)
})

test('rows pruned from the spool are reported to the gateway exactly once', async () => {
  const dir = tmp()
  const g = await gateway()
  // maxBytes 1: any batch pushed to the spool is immediately pruned, and counted.
  const log = track(createLogger(opts({ url: g.url, spool: { dir, maxBytes: 1 } })))
  await waitFor(() => g.conns.length >= 1)
  await sleep(100)                                   // hello landed: batches go straight out
  log.info('a'); await log.flush()
  expect(g.batches[0].prunedBatchesSinceLast ?? 0).toBe(0)

  await g.stop()
  log.info('lost'); await log.flush()                // spooled, then pruned for size
  await g.start()
  await waitFor(() => g.conns.length >= 2, 5000)
  await sleep(100)                                   // let hello land so the next batch goes straight out

  log.info('c'); await log.flush()
  const c = g.batches.find((b) => b.entries.some((e) => e.msg === 'c'))
  expect(c?.prunedBatchesSinceLast).toBe(1)
  expect(c?.droppedSinceLast).toBeUndefined()        // pruned batches are not dropped entries
  log.info('d'); await log.flush()
  const d = g.batches.find((b) => b.entries.some((e) => e.msg === 'd'))
  expect(d?.prunedBatchesSinceLast ?? 0).toBe(0)     // never double-reported
})

test('replays more spooled batches than the ack window, each exactly once', async () => {
  const dir = tmp()
  // One entry per batch and two slots: the drain loop has to wait for acks to free the window.
  const g = await gateway({ hello: { ackWindow: 2, maxEntriesPerBatch: 1 } })
  const log = track(createLogger(opts({ url: g.url, spool: { dir } })))
  log.info('opens the stream'); await log.flush()

  await g.stop()
  for (let i = 0; i < 10; i++) log.info(`spooled-${i}`)
  const rows = spoolRows(dir)
  try {
    await waitFor(() => rows.count() === 10)
    await g.start()
    await waitFor(() => rows.count() === 0, 5000)
  } finally {
    rows.close()
  }
  const msgs = g.batches.flatMap((b) => b.entries).map((e) => e.msg)
  expect(new Set(msgs).size).toBe(msgs.length)
  expect(g.batches.every((b) => b.entries.length === 1)).toBe(true)
  for (let i = 0; i < 10; i++) expect(msgs).toContain(`spooled-${i}`)
})
