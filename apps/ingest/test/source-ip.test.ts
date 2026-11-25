import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LogEntry } from '@logguber/shared'
import { LOKI_LIMITS } from '@logguber/shared'
import { pushToLoki } from '../src/loki.ts'

/** The gateway stamps the address it resolved for the sender onto every entry.
 *  It is the one field on a log line that the sender cannot shape, so these
 *  tests care as much about where it cannot be forged as about where it lands. */

type Pushed = { stream: Record<string, string>; values: [string, string, Record<string, string>][] }

function captureFetch(): () => Pushed[] {
  const seen: Pushed[] = []
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    seen.push(...(JSON.parse(init.body) as { streams: Pushed[] }).streams)
    return { ok: true, status: 200, text: async () => '' } as Response
  })
  return () => seen
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  ts: new Date('2026-01-01T00:00:00.000Z').toISOString(),
  level: 'info',
  msg: 'hello',
  dims: {},
  ...over,
})

const push = (entries: LogEntry[], sourceIp?: string) =>
  pushToLoki(entries, 'atlas', 'prod', { url: 'http://loki', metadataKeys: [], sourceIp })

describe('source ip stamping', () => {
  it('lands in structured metadata and in the line body', async () => {
    const seen = captureFetch()
    await push([entry()], '203.0.113.7')

    const [, line, meta] = seen()[0].values[0]
    expect(meta.source_ip).toBe('203.0.113.7')
    // Both copies, deliberately: Loki does not return structured metadata from
    // every query path, so a reader of the line alone would otherwise see none.
    expect(JSON.parse(line)._source_ip).toBe('203.0.113.7')
  })

  it('cannot be overridden by a sender that supplies its own', async () => {
    const seen = captureFetch()
    await push([entry({ meta: { _source_ip: '10.0.0.1', http: { path: '/x' } } })], '203.0.113.7')

    const [, line, meta] = seen()[0].values[0]
    expect(JSON.parse(line)._source_ip).toBe('203.0.113.7')
    expect(meta.source_ip).toBe('203.0.113.7')
  })

  it('is absent when the gateway did not resolve one', async () => {
    const seen = captureFetch()
    await push([entry()])

    const [, line, meta] = seen()[0].values[0]
    expect(meta.source_ip).toBeUndefined()
    expect('_source_ip' in JSON.parse(line)).toBe(false)
  })

  it('survives a line that had to be truncated', async () => {
    const seen = captureFetch()
    await push([entry({ meta: { blob: 'x'.repeat(LOKI_LIMITS.maxLineBytes + 1) } })], '203.0.113.7')

    const body = JSON.parse(seen()[0].values[0][1])
    expect(body._line_truncated).toBe(true)
    expect(body._source_ip).toBe('203.0.113.7')
  })

  it('survives a sender that fills the metadata budget with its own dims', async () => {
    const seen = captureFetch()
    const dims: Record<string, string> = {}
    const keys: string[] = []
    for (let i = 0; i < LOKI_LIMITS.maxMetadataEntries + 5; i++) {
      dims['d' + i] = 'v'
      keys.push('d' + i)
    }
    await pushToLoki([entry({ dims })], 'atlas', 'prod', {
      url: 'http://loki',
      metadataKeys: keys,
      sourceIp: '203.0.113.7',
    })

    expect(seen()[0].values[0][2].source_ip).toBe('203.0.113.7')
  })
})
