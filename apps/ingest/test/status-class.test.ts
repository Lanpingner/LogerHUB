import { describe, expect, it } from 'vitest'
import type { LogEntry } from '@logguber/shared'
import { rollupRows } from '../src/rollup.ts'
import { openStore } from '../src/store.ts'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The usage counters now record HTTP status classes, so a success rate can be
 *  a success rate. The old proxy was error-level lines over all lines, which
 *  called a 500 logged at info a success. */

const req = (status: unknown, level: LogEntry['level'] = 'info'): LogEntry => ({
  ts: new Date('2026-01-01T00:30:00.000Z').toISOString(),
  level,
  kind: 'request',
  msg: 'GET /x',
  dims: {},
  meta: { http: { status } },
})

const at = (rows: ReturnType<typeof rollupRows>, depth = 1) => rows.find((r) => r.depth === depth)!

describe('status class counting', () => {
  it('splits 4xx from 5xx and counts both as classified', () => {
    const row = at(rollupRows([req(200), req(404), req(422), req(500), req(503)], 'api', ['service']))
    expect(row.requests).toBe(5)
    expect(row.classified).toBe(5)
    expect(row.client_errors).toBe(2)
    expect(row.server_errors).toBe(2)
    // Success is what is left over, so it never needs its own column.
    expect(row.classified - row.client_errors - row.server_errors).toBe(1)
  })

  it('counts a 500 logged at info as a server error, which the level proxy could not', () => {
    const row = at(rollupRows([req(500, 'info')], 'api', ['service']))
    expect(row.server_errors).toBe(1)
    // The level-based counter still reads zero: that is the bug, preserved here
    // so the two cannot be confused again.
    expect(row.errors).toBe(0)
  })

  it('leaves a request with no status unclassified rather than counting it as a success', () => {
    const row = at(rollupRows([req(undefined), req(200)], 'api', ['service']))
    expect(row.requests).toBe(2)
    expect(row.classified).toBe(1)
  })

  it('does not classify a status that is not a number', () => {
    // A string would otherwise inflate the denominator with a line that carries
    // no usable classification.
    const row = at(rollupRows([req('200'), req(null), req(Number.NaN)], 'api', ['service']))
    expect(row.classified).toBe(0)
    expect(row.client_errors).toBe(0)
    expect(row.server_errors).toBe(0)
  })

  it('ignores the status on an entry that is not a request', () => {
    const mcp: LogEntry = { ...req(500), kind: 'mcp' }
    const plain: LogEntry = { ...req(500), kind: undefined }
    const row = at(rollupRows([mcp, plain], 'api', ['service']))
    expect(row.requests).toBe(0)
    expect(row.classified).toBe(0)
    expect(row.server_errors).toBe(0)
  })

  it('counts at every hierarchy depth', () => {
    const e = { ...req(500), dims: { company_id: 'acme' } }
    const rows = rollupRows([e], 'api', ['service', 'company_id'])
    expect(rows.map((r) => r.depth)).toEqual([1, 2])
    for (const r of rows) {
      expect(r.classified).toBe(1)
      expect(r.server_errors).toBe(1)
    }
  })
})

describe('a database recorded before the status columns existed', () => {
  /** The schema as it shipped before `classified` and the two error counts. */
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

  it('keeps its history and reads zero for the classes it never recorded', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'lh-status-')), 'legacy.db')
    legacy(file)
    const store = openStore(file)
    try {
      const [row] = store.usage({ depth: 1, sinceHours: 24 * 365 * 100 })
      expect(row).toMatchObject({ requests: 900, errors: 7 })
      // Zero, not a guess derived from `errors`: 900 requests of which none is
      // classified is the honest record, and it is what makes the console show
      // a dash instead of claiming 100% success for that hour.
      expect(row).toMatchObject({ classified: 0, client_errors: 0, server_errors: 0 })
    } finally {
      store.close()
    }
  })

  it('counts new requests into the added columns beside the old rows', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'lh-status-')), 'counting.db')
    legacy(file)
    const store = openStore(file)
    try {
      store.rollup(rollupRows([req(500), req(404), req(200)], 'api', ['service']))
      const rows = store.usage({ depth: 1, sinceHours: 24 * 365 * 100 })
      expect(rows.find((r) => r.requests === 900)).toBeDefined()
      const fresh = rows.find((r) => r.classified === 3)
      expect(fresh).toMatchObject({ client_errors: 1, server_errors: 1 })
    } finally {
      store.close()
    }
  })
})
