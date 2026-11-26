import { hostname } from 'node:os'
import { createLogger } from '../src/logger'
import { resolveInstance } from '../src/logger'
import { createStubGateway, type StubGateway } from './helpers/stub-gateway'
import { base } from './helpers/fixtures'

/** The `instance` dimension is what makes "which replica is failing?" an
 *  answerable question, so it is stamped by default. These tests pin both the
 *  default and the opt-out, because the default sends a hostname and an
 *  operator who does not want that must be able to stop it. */

const gateways: StubGateway[] = []
const closeables: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  for (const c of closeables.splice(0)) await c.close()
  for (const g of gateways.splice(0)) await g.close()
})

// `base` opts out of `instance` so the other suites can assert exact dims; this
// one is about the default, so it drops that opt-out and sets it per test.
const { instance: _optedOut, ...baseWithoutInstance } = base

async function dimsOf(extra: Record<string, unknown>): Promise<Record<string, string> | undefined> {
  const g = await createStubGateway()
  gateways.push(g)
  const log = createLogger({ ...baseWithoutInstance, url: g.url, ...extra } as never)
  closeables.push(log)
  log.info('hello')
  await log.flush()
  return g.batches[0].entries[0].dims
}

test('every entry carries the hostname as its instance by default', async () => {
  expect((await dimsOf({}))?.instance).toBe(hostname())
})

test('a chosen instance replaces the hostname', async () => {
  expect((await dimsOf({ instance: 'web-3' }))?.instance).toBe('web-3')
})

test('instance: false sends no instance at all', async () => {
  const dims = await dimsOf({ instance: false })
  expect(dims?.instance).toBeUndefined()
})

test('an explicit dims.instance wins over the resolved one', async () => {
  // The caller naming its own instance knows more than the hostname does.
  expect((await dimsOf({ dims: { instance: 'pod-7' } }))?.instance).toBe('pod-7')
  expect((await dimsOf({ instance: 'ignored', dims: { instance: 'pod-7' } }))?.instance).toBe('pod-7')
})

test('resolveInstance trims, drops blanks and caps length', () => {
  expect(resolveInstance('  web-3  ')).toBe('web-3')
  expect(resolveInstance('   ')).toBeUndefined()
  expect(resolveInstance('')).toBeUndefined()
  expect(resolveInstance('x'.repeat(200))).toHaveLength(64)
})

test('resolveInstance falls back to the hostname when given nothing', () => {
  expect(resolveInstance(undefined)).toBe(hostname())
  expect(resolveInstance(false)).toBeUndefined()
})
