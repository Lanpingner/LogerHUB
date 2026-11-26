import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express5 from 'express'
import express4 from 'express4'
import type { BatchFrame, LogEntry } from '@logguber/shared'
import { createLogger } from '../../src/logger'
import type { Logger, LoggerOptions, MiddlewareOptions } from '../../src/types'
import { createStubGateway } from './stub-gateway'

export function entry(msg: string): LogEntry {
  return { ts: new Date().toISOString(), level: 'info', msg }
}

/** A one-entry batch; `pad` inflates the message so tests can control row size. */
export function batch(id: string, pad = ''): BatchFrame {
  return { t: 'batch', id, entries: [entry(`m-${id}${pad}`)] }
}

const dirs: string[] = []

/** A fresh empty directory under os.tmpdir(), removed after the suite. */
export function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'logguber-'))
  dirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Shared transport/client options; spread into each test's options. */
export const base = {
  apiKey: 'lgb_test_secret',
  service: 'public-api',
  env: 'test',
  onError: () => {},
  // Off here so a test asserting a dims object gets back what it put in. The
  // default — the machine's hostname — would otherwise appear in every one of
  // them, and the assertion would depend on the name of the machine running the
  // suite. The default itself is pinned in instance.test.ts.
  instance: false as const,
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Polls `fn` every 5ms until truthy; rejects after `timeoutMs` (default 2000). */
export async function waitFor(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`)
    await sleep(5)
  }
}

const teardown: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const fn of teardown.splice(0)) await fn()
})

/** The Express major `appWith` builds on by default; the middleware suite sets it per run. */
export let currentMajor: 4 | 5 = 5
export const useExpress = (m: 4 | 5): void => {
  currentMajor = m
}

/** An entry as the gateway received it: `meta` is untyped JSON, so tests index into it freely. */
export type Received = Omit<LogEntry, 'meta'> & { meta: any }

/**
 * A small Express app with the middleware installed, observed through the real path: a logger
 * connected to a stub gateway, with entries read from the batches the gateway received.
 * `entries()` flushes first, so call it after the requests have completed.
 */
export async function appWith(
  opts: MiddlewareOptions = {},
  loggerOpts: Partial<LoggerOptions> = {},
  major: 4 | 5 = currentMajor,
) {
  const express = (major === 4 ? express4 : express5) as typeof express5
  const gateway = await createStubGateway()
  const log: Logger = createLogger({ ...base, url: gateway.url, ...loggerOpts })
  teardown.push(async () => {
    await log.close()
    await gateway.close()
  })
  await waitFor(() => gateway.conns.length > 0)

  const app = express()
  app.set('env', 'test') // keeps Express's default error handler from printing stack traces
  app.use(log.expressMiddleware(opts))
  app.use(express.json())
  app.get('/users/:id', (_req, res) => void res.json({ id: 1, token: 'sekret' }))
  app.get('/slow', (_req, res) => void setTimeout(() => res.json({ ok: true }), 25))
  app.get('/head-only', (_req, res) => {
    res.writeHead(204)
    res.end()
  })
  app.get('/head-gap', (_req, res) => {
    res.writeHead(204)
    // Blocks the loop so end() cannot be what marks the first byte before the gap is measured.
    const until = Date.now() + 25
    while (Date.now() < until);
    res.end()
  })
  app.get('/gap', (_req, res) => {
    res.write('a')
    setTimeout(() => res.end('b'), 25)
  })
  app.get('/double-end-gap', (_req, res) => {
    res.on('error', () => {})
    res.setHeader('Content-Type', 'application/json')
    res.end('{"a":1}')
    // Blocks the loop so 'finish' cannot fire between the two calls: the second end() lands
    // before the line is emitted, which is the only case where moving the mark would show.
    const until = Date.now() + 25
    while (Date.now() < until);
    res.end('{"a":2}')
  })
  app.get('/health', (_req, res) => void res.send('ok'))
  app.get('/boom', (_req, res) => void res.status(500).json({ error: 'boom' }))
  app.get('/throws', () => {
    throw new Error('thrown')
  })
  app.post('/echo', (req, res) => void res.json(req.body))
  app.post('/fail', (req, res) => void res.status(500).json({ error: 'nope', password: 'hunter2', echo: req.body }))
  app.get('/big', (_req, res) => void res.json({ pad: 'x'.repeat(500) }))
  app.get('/text', (_req, res) => void res.type('text/plain').send('plain words'))
  app.get('/stream', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.write('a')
    res.write('b')
    res.end('c')
  })
  app.get('/stream-json', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.end('{"a":1}') // parseable as JSON, but a stream: must still not be captured
  })
  app.get('/chunked', (_req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.write('{"a":')
    res.write('"' + 'y'.repeat(100) + '"')
    res.end('}')
  })
  app.get('/double-end', (_req, res) => {
    res.on('error', () => {}) // Node reports the second end() as an error event; that is the app's bug, not ours
    res.setHeader('Content-Type', 'application/json')
    res.end('{"a":1}')
    res.end('{"a":2}')
  })
  const nested = express.Router()
  nested.get('/items/:sku', (_req, res) => void res.json({ ok: true }))
  app.use('/v1', nested)
  const state = { hangHits: 0 }
  app.get('/hang', () => void state.hangHits++) // never responds

  const entries = async (): Promise<Received[]> => {
    await log.flush()
    return gateway.batches.flatMap((b) => b.entries) as Received[]
  }
  return { app, log, entries, gateway, state }
}
