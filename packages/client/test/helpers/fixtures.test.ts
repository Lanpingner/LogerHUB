import { existsSync } from 'node:fs'
import { entry, tmp } from './fixtures'

test('fixtures: entry is valid and tmp is a fresh empty directory', () => {
  const e = entry('hi')
  expect(e).toMatchObject({ level: 'info', msg: 'hi' })
  expect(new Date(e.ts).toISOString()).toBe(e.ts)
  expect(existsSync(tmp())).toBe(true)
  expect(tmp()).not.toBe(tmp())
})
