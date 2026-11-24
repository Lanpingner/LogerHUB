import request from 'supertest'
import { appWith } from './helpers/fixtures'

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
    { console: { enabled: true, stream: out.stream, label: 'index.js' } },
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
    { console: { enabled: true, pending: true, stream: tty } },
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
