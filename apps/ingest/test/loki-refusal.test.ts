import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LogEntry } from '@logguber/shared'
import { LokiPushError, pushToLoki } from '../src/loki.ts'

/** Loki refuses some batches permanently — an entry too old, or older than the
 *  same stream has already accepted. Retrying those forever means the client
 *  never drains its spool, so the distinction has to survive. */

afterEach(() => vi.unstubAllGlobals())

const entry: LogEntry = {
  ts: new Date().toISOString(),
  level: 'info',
  msg: 'x',
  dims: {},
}

function respond(status: number, body = 'nope') {
  vi.stubGlobal('fetch', async () => ({ ok: status < 400, status, text: async () => body }) as Response)
}

const push = () => pushToLoki([entry], 'api', 'prod', { url: 'http://loki', metadataKeys: [] })

describe('a refused push', () => {
  it('is not retryable when Loki rejects the entries themselves', async () => {
    respond(400, 'entry too far behind')
    const err = await push().catch((e) => e)
    expect(err).toBeInstanceOf(LokiPushError)
    expect(err.status).toBe(400)
    expect(err.retryable).toBe(false)
    // The detail survives, because it is the only record of what was lost.
    expect(err.message).toContain('entry too far behind')
  })

  it('is retryable when Loki is rate limiting or broken', async () => {
    for (const status of [429, 500, 502, 503]) {
      respond(status)
      const err = await push().catch((e) => e)
      expect(err.retryable, 'status ' + status).toBe(true)
    }
  })

  it('treats other client errors as verdicts too', async () => {
    for (const status of [401, 403, 404, 413, 422]) {
      respond(status)
      const err = await push().catch((e) => e)
      expect(err.retryable, 'status ' + status).toBe(false)
    }
  })

  it('does not throw at all when Loki accepts', async () => {
    respond(204)
    await expect(push()).resolves.toBeUndefined()
  })
})
