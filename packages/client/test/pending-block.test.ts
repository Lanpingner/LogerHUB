import { createConsoleView } from '../src/console'
import type { LogEntry } from '@logguber/shared'

/**
 * A minimal terminal, so these tests assert on what a person would SEE rather than on
 * the escape codes we happen to emit. Without this, a redraw that appends a fresh block
 * instead of overwriting the old one passes every "did we write the line" assertion
 * while filling the screen with duplicates.
 *
 * Supports exactly what the console view uses: cursor up, erase-to-end-of-line,
 * erase-to-end-of-screen, and newline.
 */
function terminal(isTTY = true) {
  const rows: string[] = ['']
  let cur = 0
  let col = 0

  const put = (text: string): void => {
    const row = rows[cur] ?? ''
    const padded = row.length < col ? row + ' '.repeat(col - row.length) : row
    rows[cur] = padded.slice(0, col) + text + padded.slice(col + text.length)
    col += text.length
  }

  const stream = {
    isTTY,
    write(data: string): boolean {
      // eslint-disable-next-line no-control-regex
      const parts = data.split(/(\x1B\[[0-9;]*[A-Za-z]|\n)/)
      for (const part of parts) {
        if (part === '') continue
        if (part === '\n') {
          cur++
          col = 0
          while (rows.length <= cur) rows.push('')
          continue
        }
        // eslint-disable-next-line no-control-regex
        const m = /^\x1B\[([0-9;]*)([A-Za-z])$/.exec(part)
        if (m) {
          const n = m[1] === '' ? 1 : Number(m[1].split(';')[0])
          if (m[2] === 'A') cur = Math.max(0, cur - n)
          else if (m[2] === 'K') rows[cur] = (rows[cur] ?? '').slice(0, col)
          else if (m[2] === 'J') {
            rows[cur] = (rows[cur] ?? '').slice(0, col)
            rows.length = cur + 1
          }
          // 'm' is colour; everything else is ignored on purpose.
          continue
        }
        put(part)
      }
      return true
    },
  }

  return {
    stream: stream as unknown as NodeJS.WriteStream,
    /** What is on screen, with colour stripped and trailing blanks dropped. */
    screen(): string[] {
      // eslint-disable-next-line no-control-regex
      const clean = rows.map((r) => r.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').trimEnd())
      while (clean.length > 0 && clean[clean.length - 1] === '') clean.pop()
      return clean
    },
  }
}

const req = (id: string, url: string) => ({ id, method: 'GET', url, ip: '127.0.0.1', startedAt: Date.now() })

const done = (id: string, url: string, status: number): LogEntry => ({
  ts: new Date().toISOString(),
  level: 'info',
  msg: `GET ${url} ${status}`,
  kind: 'request',
  meta: { http: { method: 'GET', path: url, status, duration_ms: 12, request_id: id } },
})

test('the in-flight block is redrawn in place, not appended', () => {
  const t = terminal()
  const view = createConsoleView({ enabled: true, pending: true, stream: t.stream }, 'svc')

  view.pendingAdd(req('aaa', '/one'))
  view.pendingAdd(req('bbb', '/two'))
  view.pendingAdd(req('ccc', '/three'))

  const screen = t.screen()
  // Three requests in flight means three lines on screen — not three blocks of
  // one, two and three lines stacked on top of each other.
  expect(screen).toHaveLength(3)
  expect(screen.filter((l) => l.includes('/one'))).toHaveLength(1)
  expect(screen.filter((l) => l.includes('/two'))).toHaveLength(1)
  expect(screen.filter((l) => l.includes('/three'))).toHaveLength(1)
  expect(screen.every((l) => l.includes('pending...'))).toBe(true)
})

test('a finished request leaves its line above and shrinks the block', () => {
  const t = terminal()
  const view = createConsoleView({ enabled: true, pending: true, stream: t.stream }, 'svc')

  view.pendingAdd(req('aaa', '/one'))
  view.pendingAdd(req('bbb', '/two'))
  view.pendingRemove('aaa')
  view.write(done('aaa', '/one', 200))

  const screen = t.screen()
  // The finished line, then the one request still in flight. Nothing else.
  expect(screen).toHaveLength(2)
  expect(screen[0]).toContain('— 200')
  expect(screen[0]).not.toContain('pending...')
  expect(screen[1]).toContain('/two')
  expect(screen[1]).toContain('pending...')
  // The request that finished must not still be shown as in flight.
  expect(screen.some((l) => l.includes('/one') && l.includes('pending...'))).toBe(false)
})

test('many requests churning leave one block of exactly the open ones', () => {
  const t = terminal()
  const view = createConsoleView({ enabled: true, pending: true, stream: t.stream }, 'svc')

  // The shape of the reported problem: a burst of overlapping requests, each
  // finishing at a different time, with log lines interleaved.
  for (let i = 0; i < 12; i++) view.pendingAdd(req('r' + i, '/res/' + i))
  for (let i = 0; i < 12; i += 2) {
    view.pendingRemove('r' + i)
    view.write(done('r' + i, '/res/' + i, 200))
  }

  const screen = t.screen()
  const stillPending = screen.filter((l) => l.includes('pending...'))
  const finished = screen.filter((l) => l.includes('— 200'))
  expect(stillPending).toHaveLength(6)
  expect(finished).toHaveLength(6)
  // Every finished line sits above the block, and the block holds only odd ids.
  for (let i = 0; i < 12; i++) {
    const shown = stillPending.filter((l) => l.includes('/res/' + i + ' ')).length
    expect(shown).toBe(i % 2 === 0 ? 0 : 1)
  }
  expect(screen).toHaveLength(12)
})

test('the block is emptied on close, leaving only real log lines', () => {
  const t = terminal()
  const view = createConsoleView({ enabled: true, pending: true, stream: t.stream }, 'svc')
  view.write(done('x', '/first', 200))
  view.pendingAdd(req('aaa', '/one'))
  view.pendingAdd(req('bbb', '/two'))
  view.close()

  const screen = t.screen()
  expect(screen).toHaveLength(1)
  expect(screen[0]).toContain('/first')
})

test('the in-flight block is not drawn when the stream is not a terminal', () => {
  // The reported symptom: under PM2 (or any redirect) stdout is a file, and cursor
  // movement written into a file turns into stacked duplicate blocks. Asking for
  // colour must not be read as "this is a terminal".
  const t = terminal(false)
  const view = createConsoleView({ enabled: true, pending: true, color: true, stream: t.stream }, 'svc')
  view.pendingAdd(req('aaa', '/one'))
  view.pendingAdd(req('bbb', '/two'))
  view.write(done('aaa', '/one', 200))

  const screen = t.screen()
  expect(screen.some((l) => l.includes('pending...'))).toBe(false)
  expect(screen).toHaveLength(1)
  expect(screen[0]).toContain('— 200')
})

test('colour can be forced on a non-terminal without enabling the block', () => {
  const written: string[] = []
  const stream = { isTTY: false, write: (s: string) => (written.push(s), true) } as unknown as NodeJS.WriteStream
  const view = createConsoleView({ enabled: true, color: true, pending: true, stream }, 'svc')
  view.write({ ts: new Date().toISOString(), level: 'error', msg: 'boom' })
  const text = written.join('')
  expect(text).toContain('\x1B[31m') // colour honoured
  expect(text).not.toContain('\x1B[1A') // no cursor movement
})
