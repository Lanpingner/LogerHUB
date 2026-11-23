import { canonicalDims } from '../src/canonical'

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
