import { matches, parse, type Candidate } from '../src/query.ts'

/** `matches` is the live view's hot path: it runs once per buffered row per
 *  render. These tests pin its observable behaviour so the caching inside it
 *  cannot quietly change an answer. */

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    service: 'office-api-demo',
    env: 'dev',
    level: 'info',
    msg: 'GET /api/v1/properties/42/bookings 200',
    dims: { company_id: 'acme', user_id: 'u-1' },
    meta: { http: { method: 'GET', status: 200, duration_ms: 12.5, path: '/api/v1/properties/42/bookings' } },
    ...over,
  }
}

const q = (s: string) => parse(s).query

describe('free-text matching', () => {
  test('an empty query matches everything without inspecting the row', () => {
    expect(matches(candidate(), q(''))).toBe(true)
  })

  test('a term found in msg matches', () => {
    expect(matches(candidate(), q('bookings'))).toBe(true)
  })

  test('a term found only in meta matches', () => {
    expect(matches(candidate({ msg: 'request' }), q('duration_ms'))).toBe(true)
  })

  test('a term present in neither does not match', () => {
    expect(matches(candidate(), q('timeout'))).toBe(false)
  })

  test('matching is case-insensitive in msg and in meta', () => {
    expect(matches(candidate({ msg: 'Cache MISS' }), q('cache miss'.split(' ')[1]))).toBe(true)
    expect(matches(candidate(), q('DURATION_MS'))).toBe(true)
  })

  test('a term spanning the join between msg and meta still matches', () => {
    // The haystack is `msg + ' ' + JSON.stringify(meta)`, so a needle may
    // straddle that single space. Caching the two halves separately would
    // silently lose this, which is why it is pinned here.
    const c = candidate({ msg: 'alpha', meta: { beta: 1 } })
    // A needle cannot itself contain a quote: the tokenizer strips every `"`.
    expect(matches(c, q('"alpha {"'))).toBe(true)
    expect(matches(c, q('"lpha {"'))).toBe(true)
  })

  test('NOT negates a text term', () => {
    expect(matches(candidate(), q('NOT timeout'))).toBe(true)
    expect(matches(candidate(), q('NOT bookings'))).toBe(false)
  })

  test('two rows sharing one meta object but differing in msg are judged separately', () => {
    // toRow builds a fresh payload per row, but nothing guarantees it, and a
    // cache keyed only on the meta object would answer the second row from the
    // first row's haystack.
    const meta = { http: { status: 200 } }
    expect(matches(candidate({ msg: 'alpha', meta }), q('alpha'))).toBe(true)
    expect(matches(candidate({ msg: 'beta', meta }), q('alpha'))).toBe(false)
    expect(matches(candidate({ msg: 'beta', meta }), q('beta'))).toBe(true)
  })

  test('repeated evaluation of the same row and query is stable', () => {
    const c = candidate()
    const query = q('bookings')
    for (let i = 0; i < 5; i++) expect(matches(c, query)).toBe(true)
  })
})

describe('field matching', () => {
  test('a label field compares against the row label', () => {
    expect(matches(candidate(), q('level:info'))).toBe(true)
    expect(matches(candidate(), q('level:error'))).toBe(false)
  })

  test('a label comparison ignores case', () => {
    expect(matches(candidate({ level: 'INFO' }), q('level:info'))).toBe(true)
  })

  test('a meta field is read out of meta.http', () => {
    expect(matches(candidate(), q('method:GET'))).toBe(true)
    expect(matches(candidate(), q('method:POST'))).toBe(false)
  })

  test('a dim takes precedence over meta.http for the same label', () => {
    expect(matches(candidate(), q('company:acme'))).toBe(true)
  })

  test('a field absent from the row does not match, but its negation does', () => {
    // Current behaviour: an absent field is a miss, and NOT inverts the miss,
    // so `NOT method:GET` keeps rows that carry no method at all. Pinned
    // because it is surprising, not because it is obviously right.
    const c = candidate({ meta: {}, dims: {} })
    expect(matches(c, q('method:GET'))).toBe(false)
    expect(matches(c, q('NOT method:GET'))).toBe(true)
  })

  test('numeric operators compare numerically, not lexically', () => {
    expect(matches(candidate(), q('status:>=200'))).toBe(true)
    expect(matches(candidate(), q('status:>200'))).toBe(false)
    expect(matches(candidate(), q('duration:>12'))).toBe(true)
    expect(matches(candidate(), q('duration:<12'))).toBe(false)
    expect(matches(candidate({ meta: { http: { status: 9 } } }), q('status:<10'))).toBe(true)
  })
})

describe('wildcard matching', () => {
  test('a wildcard is anchored, so * is the only way to match a substring', () => {
    expect(matches(candidate(), q('path:*bookings*'))).toBe(true)
    expect(matches(candidate(), q('path:*bookings'))).toBe(true) // anchored at the end
    expect(matches(candidate(), q('path:bookings*'))).toBe(false) // path does not start there
    expect(matches(candidate(), q('path:/api/v1/properties/42/bookings'))).toBe(true)
  })

  test('a wildcard is case-insensitive', () => {
    expect(matches(candidate(), q('path:*BOOKINGS*'))).toBe(true)
  })

  test('regex metacharacters in the value are literal, not pattern syntax', () => {
    const c = candidate({ meta: { http: { path: '/a+b' } } })
    expect(matches(c, q('path:*a+b*'))).toBe(true)
    expect(matches(c, q('path:*aab*'))).toBe(false)
    const dotted = candidate({ meta: { http: { path: '/axb' } } })
    expect(matches(dotted, q('path:*a.b*'))).toBe(false)
  })

  test('a wildcard term is stable across repeated evaluation and across rows', () => {
    // The compiled pattern is cached on the node; it must not pick up the
    // first row it saw.
    const query = q('path:*bookings*')
    const hit = candidate()
    const miss = candidate({ meta: { http: { path: '/health' } } })
    for (let i = 0; i < 3; i++) {
      expect(matches(hit, query)).toBe(true)
      expect(matches(miss, query)).toBe(false)
    }
  })

  test('a negated wildcard inverts', () => {
    expect(matches(candidate(), q('NOT path:*health*'))).toBe(true)
    expect(matches(candidate(), q('NOT path:*bookings*'))).toBe(false)
  })
})

describe('clause combination', () => {
  test('terms in one clause are ANDed', () => {
    expect(matches(candidate(), q('level:info method:GET'))).toBe(true)
    expect(matches(candidate(), q('level:info method:POST'))).toBe(false)
  })

  test('OR separates clauses', () => {
    expect(matches(candidate(), q('level:error OR method:GET'))).toBe(true)
    expect(matches(candidate(), q('level:error OR method:POST'))).toBe(false)
  })

  test('a text term and a field term combine', () => {
    expect(matches(candidate(), q('bookings status:200'))).toBe(true)
    expect(matches(candidate(), q('bookings status:500'))).toBe(false)
  })
})
