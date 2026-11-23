import { canonicalDims } from '../src/canonical'
import { LEVELS, HELLO_DEFAULTS, LOKI_LIMITS } from '../src/protocol'

const levels = ['service', 'company_id', 'user_id']

test('sorts keys so equal dimension sets produce one string', () => {
  const a = canonicalDims({ user_id: 'u1', service: 'api', company_id: 'acme' }, levels)
  const b = canonicalDims({ service: 'api', company_id: 'acme', user_id: 'u1' }, levels)
  expect(a).toBe(b)
  expect(a).toBe('{"company_id":"acme","service":"api","user_id":"u1"}')
})

test('fills missing and empty dimensions with unknown rather than omitting them', () => {
  expect(canonicalDims({ service: 'api' }, levels))
    .toBe('{"company_id":"unknown","service":"api","user_id":"unknown"}')
  expect(canonicalDims({ service: 'api', company_id: '', user_id: undefined }, levels))
    .toBe('{"company_id":"unknown","service":"api","user_id":"unknown"}')
})

test('ignores dimensions outside the configured levels', () => {
  expect(canonicalDims({ service: 'api', region: 'eu' }, ['service'])).toBe('{"service":"api"}')
})

test('empty levels produce an empty object', () => {
  expect(canonicalDims({ service: 'api' }, [])).toBe('{}')
})

test('levels order does not matter and duplicates collapse', () => {
  const dims = { service: 'api', company_id: 'acme' }
  const expected = '{"company_id":"acme","service":"api"}'
  expect(canonicalDims(dims, ['service', 'company_id'])).toBe(expected)
  expect(canonicalDims(dims, ['company_id', 'service'])).toBe(expected)
  expect(canonicalDims(dims, ['service', 'company_id', 'service'])).toBe(expected)
})

test('special level names still appear as unknown when absent', () => {
  expect(canonicalDims({}, ['constructor', 'toString', '__proto__']))
    .toBe('{"__proto__":"unknown","constructor":"unknown","toString":"unknown"}')
})

test('special level names use own values when present', () => {
  const dims = JSON.parse('{"__proto__":"p","constructor":"c"}')
  expect(canonicalDims(dims, ['__proto__', 'constructor']))
    .toBe('{"__proto__":"p","constructor":"c"}')
})

test('does not mutate the levels array', () => {
  const lv = ['b', 'a', 'b']
  canonicalDims({}, lv)
  expect(lv).toEqual(['b', 'a', 'b'])
})

test('coerces non-string runtime values', () => {
  const dims = { a: 5, b: null, c: { x: 1 }, d: '   ', e: true, f: [1] } as unknown as Record<string, string>
  expect(canonicalDims(dims, ['a', 'b', 'c', 'd', 'e', 'f']))
    .toBe('{"a":"5","b":"unknown","c":"unknown","d":"unknown","e":"true","f":"unknown"}')
})

test('protocol constants are pinned', () => {
  expect(LEVELS).toEqual(['debug', 'info', 'warn', 'error', 'fatal'])
  expect(HELLO_DEFAULTS).toEqual({ maxEntriesPerBatch: 500, maxBatchBytes: 1048576, ackWindow: 8 })
  expect(LOKI_LIMITS).toEqual({ maxLineBytes: 262144, maxMetadataEntries: 128, maxMetadataBytes: 65536 })
})
