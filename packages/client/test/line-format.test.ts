import request from 'supertest'
import { appWith } from './helpers/fixtures'
import { createConsoleView } from '../src/console'
import type { ConsoleConfig } from '../src/types'
import type { LogEntry } from '@logguber/shared'

/**
 * Pins the exact console line format. These lines are read by people at a terminal and
 * replace a local logger whose layout they already know, so the field order, the padding
 * and the separators are a contract, not an implementation detail.
 */
function capture() {
  const written: string[] = []
  return {
    stream: { isTTY: false, write: (s: string) => (written.push(s), true) } as unknown as NodeJS.WriteStream,
    lines: () =>
      written
        .join('')
        // eslint-disable-next-line no-control-regex
        .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
        .split('\n')
        .filter((l) => l.trim() !== ''),
  }
}

test('a finished request line matches the documented layout exactly', async () => {
  const out = capture()
  const { app, entries } = await appWith(
    {
      captureIp: true,
      requestId: () => 'a1b2c3d4',
      resolveMeta: () => ({
        auth: { type: 'P', cached: true },
        // One ordered record reproduces `app -> ip-exc -> user` on the line.
        tags: { app: 'OFF', 'ip-exc': true, user: '42' },
      }),
      note: () => 'cached',
    },
    { console: { enabled: true, stream: out.stream, label: 'index.js', timing: 'total' } },
  )
  await request(app).get('/users/1').expect(200)
  await entries()

  const line = out.lines().find((l) => l.includes('a1b2c3d4'))
  expect(line).toMatch(
    /^\d\d:\d\d:\d\d +\+\d+ms GET {4} \[APR\] \[a1b2c3d4\] \/users\/1 from 127\.0\.0\.1 app:OFF ip-exc user:42 — 200 \(cached\)$/,
  )
})

test('an in-flight line matches the documented layout exactly', async () => {
  const out = capture()
  // A TTY, since the in-flight block is only drawn on one.
  const tty = {
    isTTY: true,
    write: out.stream.write.bind(out.stream),
  } as unknown as NodeJS.WriteStream
  const { app, entries } = await appWith(
    { captureIp: true, pending: true, requestId: () => 'deadbeef' },
    { console: { enabled: true, pending: true, stream: tty, timing: 'total' } },
  )
  await request(app).get('/users/1').expect(200)
  await entries()

  const line = out.lines().find((l) => l.includes('pending...'))
  expect(line).toMatch(/^\d\d:\d\d:\d\d +\+\d+ms GET {4} \[deadbeef\] \/users\/1 from 127\.0\.0\.1 — pending\.\.\.$/)
})

test('a non-request line matches the documented layout exactly', async () => {
  const out = capture()
  const { log } = await appWith({}, { console: { enabled: true, stream: out.stream, label: 'index.js' } })
  log.info('cache warmed')
  await log.flush()

  const line = out.lines().find((l) => l.includes('cache warmed'))
  expect(line).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d INFO {2}\[index\.js\]: cache warmed$/)
})

// ── duration column: split vs total ──────────────────────────────────────────

/** Renders one hand-built request entry, so the numbers are exact rather than measured. */
function renderRequest(http: Record<string, unknown>, timing?: ConsoleConfig['timing']): string {
  const out = capture()
  const view = createConsoleView({ enabled: true, stream: out.stream, label: 'index.js', timing }, 'svc')
  const entry: LogEntry = {
    ts: '2026-11-24T19:21:04.000Z',
    level: 'info',
    kind: 'request',
    msg: 'GET /users/1',
    meta: {
      http: { method: 'GET', path: '/users/1', request_id: 'a1b2c3d4', status: 200, ...http },
    },
  }
  view.write(entry)
  view.close()
  return out.lines()[0]
}

/** Column where `word` starts, so two lines can be compared by alignment. */
const colOf = (line: string, word: string) => line.indexOf(' ' + word + ' ') + 1

test('the split duration renders as server+transit', () => {
  const line = renderRequest({ duration_ms: 15.5, server_ms: 12.4, transit_ms: 3.1 })
  expect(line).toMatch(/^\d\d:\d\d:\d\d +12ms\+3ms GET {4} \[a1b2c3d4\] \/users\/1 — 200$/)
})

test("timing: 'total' reproduces the pinned duration column even when a split exists", () => {
  const line = renderRequest({ duration_ms: 15.4, server_ms: 12.4, transit_ms: 3.1 }, 'total')
  // Exact string, timestamp stripped: the column is 8 wide plus its separator.
  expect(line.slice(line.indexOf(' ') + 1)).toBe('   +15ms GET     [a1b2c3d4] /users/1 — 200')
})

test('falls back to the total when the split is absent', () => {
  const line = renderRequest({ duration_ms: 15.4 })
  expect(line).toMatch(/^\d\d:\d\d:\d\d +\+15ms GET/)
})

test('falls back to the total when only one half of the split is present', () => {
  const line = renderRequest({ duration_ms: 15.4, server_ms: 12.4 })
  expect(line).toMatch(/^\d\d:\d\d:\d\d +\+15ms GET/)
})

test('the duration column is a fixed width across split and fallback lines', () => {
  const splitLine = renderRequest({ duration_ms: 15.5, server_ms: 12.4, transit_ms: 3.1 })
  const totalLine = renderRequest({ duration_ms: 15.4 })
  const longLine = renderRequest({ duration_ms: 30012, server_ms: 30000.4, transit_ms: 11.6 })
  expect(colOf(splitLine, 'GET')).toBeGreaterThan(0)
  expect(colOf(splitLine, 'GET')).toBe(colOf(totalLine, 'GET'))
  expect(colOf(longLine, 'GET')).toBe(colOf(totalLine, 'GET'))
})

test('phases never appear on the terminal line', () => {
  const line = renderRequest({
    duration_ms: 15.5,
    server_ms: 12.4,
    transit_ms: 3.1,
    timings: { db: 8.2 },
  })
  const body = line.slice(line.indexOf(' ')) // past the clock, which may contain any digit
  expect(body).not.toContain('db')
  expect(body).not.toContain('8')
})
