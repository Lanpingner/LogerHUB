import { ulid } from '../src/ulid'

/**
 * Batch ids are the gateway's deduplication key: a collision means the gateway acks a batch it
 * never stored, and those entries are gone without a trace. So these tests are about
 * uniqueness first and sortability second.
 */

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{26}$/

test('is 26 characters of Crockford base32', () => {
  for (let i = 0; i < 1000; i++) expect(ulid()).toMatch(CROCKFORD)
})

test('encodes the timestamp in the first ten characters', () => {
  const ms = 1_700_000_000_000
  expect(ulid(ms).slice(0, 10)).toBe(ulid(ms).slice(0, 10))
  expect(ulid(ms + 1).slice(0, 10) > ulid(ms).slice(0, 10)).toBe(true)
})

test('strictly increases within one frozen millisecond', () => {
  const ms = 1_700_000_000_000
  const ids = Array.from({ length: 10_000 }, () => ulid(ms))
  for (let i = 1; i < ids.length; i++) expect(ids[i] > ids[i - 1]).toBe(true)
  expect(new Set(ids).size).toBe(ids.length)
})

test('strictly increases across a millisecond boundary', () => {
  const ms = 1_700_000_000_000
  const ids = [ulid(ms), ulid(ms), ulid(ms + 1), ulid(ms + 1), ulid(ms + 2)]
  for (let i = 1; i < ids.length; i++) expect(ids[i] > ids[i - 1]).toBe(true)
})

test('mints 100k ids without a collision', () => {
  const ids = new Set<string>()
  for (let i = 0; i < 100_000; i++) ids.add(ulid())
  expect(ids.size).toBe(100_000)
})

test('the random component varies rather than being fixed for the process', () => {
  const tails = new Set([1, 2, 3, 4, 5].map((i) => ulid(1_700_000_000_000 + i).slice(10)))
  expect(tails.size).toBe(5)
})

test('two generators starting in the same millisecond do not collide', async () => {
  // Each fresh module instance stands in for another worker: same clock, independent seed.
  const ms = 1_700_000_000_000
  const sets: Array<Set<string>> = []
  for (let worker = 0; worker < 2; worker++) {
    vi.resetModules()
    const fresh = (await import('../src/ulid')) as typeof import('../src/ulid')
    sets.push(new Set(Array.from({ length: 1000 }, () => fresh.ulid(ms))))
  }
  expect(sets[0].size).toBe(1000)
  expect(sets[1].size).toBe(1000)
  for (const id of sets[0]) expect(sets[1].has(id)).toBe(false)
})

test('a backwards clock step costs ordering, never uniqueness', () => {
  const late = ulid(1_700_000_000_000)
  const early = ulid(1_699_999_999_000)
  expect(early < late).toBe(true)          // ordering follows the clock, so it does go backwards
  expect(early).not.toBe(late)
  // And the generator is still monotonic from the new, earlier time.
  const next = ulid(1_699_999_999_000)
  expect(next > early).toBe(true)
  expect(new Set([late, early, next]).size).toBe(3)
})
