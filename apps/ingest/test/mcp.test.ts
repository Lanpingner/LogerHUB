import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { LogEntry } from '@logguber/shared'
import { validate } from '../src/validate.ts'
import { rollupRows } from '../src/rollup.ts'
import { pushToLoki } from '../src/loki.ts'
import { openStore } from '../src/store.ts'

/** The gateway's half of `kind: 'mcp'`: what it is willing to store, what it
 *  promotes so `tool:` can filter server-side, and which counter a tool call
 *  moves. An existing database with real usage history has to survive the new
 *  column, so that is tested against a database created without it. */

const dirs: string[] = []
const dir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'logguber-mcp-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  vi.unstubAllGlobals()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const mcpEntry = (over: Record<string, unknown> = {}) => ({
  ts: new Date('2026-11-25T10:00:00.000Z').toISOString(),
  level: 'info',
  kind: 'mcp',
  msg: 'mcp search_issues ok',
  meta: { mcp: { role: 'server', tool: 'search_issues', call_id: 'a1b2c3d4', duration_ms: 412, ok: true } },
  ...over,
})

describe('accepting the kind', () => {
  it('keeps kind mcp', () => {
    expect(validate([mcpEntry()]).ok[0].kind).toBe('mcp')
  })

  it('still keeps kind request', () => {
    expect(validate([mcpEntry({ kind: 'request' })]).ok[0].kind).toBe('request')
  })

  it('drops a kind it does not know, keeping the line itself', () => {
    const { ok, rejected } = validate([mcpEntry({ kind: 'tool' })])
    expect(ok).toHaveLength(1)
    expect(ok[0].kind).toBeUndefined()
    expect(rejected).toBe(0)
  })

  it('drops a kind that is not even a string', () => {
    expect(validate([mcpEntry({ kind: { toString: () => 'mcp' } })]).ok[0].kind).toBeUndefined()
  })
})

describe('what Loki is told', () => {
  function captureFetch(): () => { stream: Record<string, string>; values: [string, string, Record<string, string>][] }[] {
    const seen: { stream: Record<string, string>; values: [string, string, Record<string, string>][] }[] = []
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      seen.push(...(JSON.parse(init.body) as { streams: typeof seen }).streams)
      return { ok: true, status: 200, text: async () => '' } as Response
    })
    return () => seen
  }

  it('promotes the mcp fields into structured metadata, which is what makes tool: a filter', async () => {
    const seen = captureFetch()
    await pushToLoki(validate([mcpEntry()]).ok, 'atlas-tools', 'prod', { url: 'http://loki', metadataKeys: [] })
    const [, line, meta] = seen()[0].values[0]
    expect(meta).toMatchObject({
      kind: 'mcp',
      tool: 'search_issues',
      role: 'server',
      call_id: 'a1b2c3d4',
      duration_ms: '412',
      ok: 'true',
    })
    // The line body carries them too: Loki does not return structured metadata
    // from every query path, so the console reads the line.
    expect(JSON.parse(line).mcp.tool).toBe('search_issues')
  })

  it('does not invent mcp metadata for an http entry', async () => {
    const seen = captureFetch()
    const http: LogEntry = {
      ts: new Date().toISOString(),
      level: 'info',
      kind: 'request',
      msg: 'GET / 200',
      meta: { http: { method: 'GET', status: 200 } },
    }
    await pushToLoki([http], 'api', 'prod', { url: 'http://loki', metadataKeys: [] })
    const meta = seen()[0].values[0][2]
    expect(meta.tool).toBeUndefined()
    expect(meta).toMatchObject({ method: 'GET', status: '200' })
  })
})

describe('usage counters', () => {
  const levels = ['service']

  it('counts a tool call as an mcp call and a line, never as a request', () => {
    const [row] = rollupRows(validate([mcpEntry()]).ok, 'atlas-tools', levels)
    expect(row).toMatchObject({ lines: 1, mcp_calls: 1, requests: 0 })
  })

  it('counts an http request the other way round', () => {
    const entry = { ...mcpEntry({ kind: 'request' }), meta: { http: { status: 200 } } }
    const [row] = rollupRows(validate([entry]).ok, 'api', levels)
    expect(row).toMatchObject({ lines: 1, mcp_calls: 0, requests: 1 })
  })

  it('counts a failed tool call as an error as well', () => {
    const [row] = rollupRows(validate([mcpEntry({ level: 'error' })]).ok, 'atlas-tools', levels)
    expect(row).toMatchObject({ mcp_calls: 1, errors: 1 })
  })

  it('reaches the stored row', () => {
    const store = openStore(join(dir(), 'usage.db'))
    try {
      store.rollup(rollupRows(validate([mcpEntry(), mcpEntry()]).ok, 'atlas-tools', levels))
      const [row] = store.usage({ depth: 1, sinceHours: 24 * 365 * 100 })
      expect(row).toMatchObject({ lines: 2, mcp_calls: 2, requests: 0 })
    } finally {
      store.close()
    }
  })
})

describe('an existing database', () => {
  /** The schema as it shipped before mcp_calls existed, with a row of real history. */
  function legacy(file: string): void {
    const db = new DatabaseSync(file)
    db.exec(`CREATE TABLE usage_rollup (
      hour INTEGER NOT NULL, depth INTEGER NOT NULL, dims TEXT NOT NULL,
      lines INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
      requests INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (hour, depth, dims))`)
    db.prepare('INSERT INTO usage_rollup (hour, depth, dims, lines, bytes, requests, errors) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(1764057600, 1, '{"service":"api"}', 1000, 50000, 900, 7)
    db.close()
  }

  it('gains the column without losing a counter of history', () => {
    const file = join(dir(), 'legacy.db')
    legacy(file)
    const store = openStore(file)
    try {
      const [row] = store.usage({ depth: 1, sinceHours: 24 * 365 * 100 })
      expect(row).toMatchObject({ lines: 1000, bytes: 50000, requests: 900, errors: 7, mcp_calls: 0 })
    } finally {
      store.close()
    }
  })

  it('survives being opened again, because the migration is a no-op the second time', () => {
    const file = join(dir(), 'twice.db')
    legacy(file)
    for (const _ of [1, 2, 3]) openStore(file).close()
    const store = openStore(file)
    try {
      expect(store.usage({ depth: 1, sinceHours: 24 * 365 * 100 })[0]).toMatchObject({ requests: 900, mcp_calls: 0 })
    } finally {
      store.close()
    }
  })

  it('keeps counting into the migrated column', () => {
    const file = join(dir(), 'counting.db')
    legacy(file)
    const store = openStore(file)
    try {
      store.rollup(rollupRows(validate([mcpEntry()]).ok, 'api', ['service']))
      const rows = store.usage({ depth: 1, sinceHours: 24 * 365 * 100 })
      expect(rows.find((r) => r.mcp_calls === 1)).toBeDefined()
      expect(rows.find((r) => r.requests === 900)).toBeDefined()
    } finally {
      store.close()
    }
  })
})
