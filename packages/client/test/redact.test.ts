import {
  DEFAULT_HEADER_ALLOWLIST,
  DEFAULT_REDACT_KEYS,
  byteLength,
  redactBody,
  redactHeaders,
  safeStringify,
  truncateJson,
} from '../src/redact'
import { entry, tmp } from './helpers/fixtures'
import { existsSync } from 'node:fs'

test('captures only allowlisted headers, whatever case they arrive in', () => {
  const out = redactHeaders({
    Host: 'api.example.com', 'Content-Type': 'application/json',
    Authorization: 'Bearer secret', Cookie: 'sid=abc', 'X-Api-Key': 'k',
  })
  expect(out).toEqual({ host: 'api.example.com', 'content-type': 'application/json' })
})

test('allowlist entries given in mixed case still match', () => {
  expect(redactHeaders({ 'X-Trace': 'a', Cookie: 'c' }, ['X-TRACE'])).toEqual({ 'x-trace': 'a' })
})

test('non-object header input yields no headers', () => {
  expect(redactHeaders(undefined)).toEqual({})
  expect(redactHeaders('Authorization: x')).toEqual({})
})

test('default lists match the spec exactly', () => {
  expect(DEFAULT_HEADER_ALLOWLIST).toEqual([
    'host', 'user-agent', 'content-type', 'content-length', 'accept', 'referer', 'x-request-id',
  ])
  expect(DEFAULT_REDACT_KEYS).toEqual([
    'password', 'pass', 'token', 'secret', 'apikey', 'api_key', 'authorization',
    'credential', 'card', 'cardnumber', 'cvv', 'ssn', 'otp', 'refresh_token',
  ])
})

test('redacts secret-bearing keys at any depth, case-insensitively', () => {
  expect(redactBody({ user: { Password: 'hunter2', name: 'ro' }, api_key: 'k' }))
    .toEqual({ user: { Password: '[redacted]', name: 'ro' }, api_key: '[redacted]' })
})

test('walks arrays of objects', () => {
  expect(redactBody({ items: [{ token: 't1' }, { token: 't2' }] }))
    .toEqual({ items: [{ token: '[redacted]' }, { token: '[redacted]' }] })
})

test('walks arrays nested in arrays and a top-level array body', () => {
  expect(redactBody([[{ secret: 's' }], { a: [[{ OTP: '1' }]] }]))
    .toEqual([[{ secret: '[redacted]' }], { a: [[{ OTP: '[redacted]' }]] }])
})

test('a secret key whose value is an object or array is redacted whole', () => {
  expect(redactBody({ credential: { user: 'u', pw: 'p' }, token: ['a', 'b'] }))
    .toEqual({ credential: '[redacted]', token: '[redacted]' })
})

test('redacts falsy and null secret values too', () => {
  expect(redactBody({ password: '', pass: null, cvv: 0 }))
    .toEqual({ password: '[redacted]', pass: '[redacted]', cvv: '[redacted]' })
})

test('custom redactKeys extend the defaults: both the custom key and a default are redacted', () => {
  expect(redactBody({ internal_ref: 'r', password: 'p', name: 'n' }, { redactKeys: ['internal_ref'] }))
    .toEqual({ internal_ref: '[redacted]', password: '[redacted]', name: 'n' })
})

test('custom redactKeys match case- and punctuation-insensitively', () => {
  expect(redactBody({ Foo: 1, 'F-O_o': 2 }, { redactKeys: ['FOO'] }))
    .toEqual({ Foo: '[redacted]', 'F-O_o': '[redacted]' })
})

test.each([
  'access_token', 'accessToken', 'Access-Token', 'ACCESS TOKEN', 'client_secret', 'id_token',
  'refreshToken', 'x-api-key', 'X-API-KEY', 'userPassword', 'private_key', 'privateKey',
  'db_credentials', 'Pass', 'card_number',
])('key %s is redacted after normalisation', (key) => {
  expect(redactBody({ [key]: 'v' })).toEqual({ [key]: '[redacted]' })
})

test.each(['monkey', 'keyboard', 'public_key_id', 'passenger', 'cardinal'])(
  'key %s is not redacted (no bare "key" substring match)', (key) => {
    expect(redactBody({ [key]: 'v' })).toEqual({ [key]: 'v' })
  })

test('tokenizer_version is over-redacted because it contains "token" (accepted cost)', () => {
  expect(redactBody({ tokenizer_version: '2' })).toEqual({ tokenizer_version: '[redacted]' })
})

test('class instances and toJSON values are walked, not skipped', () => {
  class Creds { constructor(public password: string, public user: string) {} }
  expect(redactBody({ c: new Creds('p', 'u') })).toEqual({ c: { password: '[redacted]', user: 'u' } })
  expect(redactBody({ wrapped: { toJSON: () => ({ token: 't', ok: 1 }) } }))
    .toEqual({ wrapped: { token: '[redacted]', ok: 1 } })
})

test('primitives pass through and circular bodies do not overflow the stack', () => {
  expect(redactBody('plain')).toBe('plain')
  expect(redactBody(null)).toBeNull()
  const c: any = { password: 'p', name: 'a' }; c.self = c
  const out = redactBody(c) as any
  expect(out.password).toBe('[redacted]')
  expect(out.self).toBe('[circular]')
})

test('a __proto__ key is kept as data and does not pollute the result', () => {
  const body = JSON.parse('{"__proto__": {"token": "t"}, "a": 1}')
  const out = redactBody(body) as any
  expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
  expect(Object.keys(out)).toEqual(['__proto__', 'a'])
})

test('allowFields mode captures nothing but the named fields', () => {
  expect(redactBody({ orderId: 'o1', status: 'paid', notes: 'private' },
                    { allowFields: ['orderId', 'status'] }))
    .toEqual({ orderId: 'o1', status: 'paid' })
})

test('allowFields still redacts secrets inside an allowed field', () => {
  expect(redactBody({ user: { name: 'a', password: 'p' }, other: 1 }, { allowFields: ['user'] }))
    .toEqual({ user: { name: 'a', password: '[redacted]' } })
})

test('allowFields never lets a secret key through, even if named', () => {
  expect(redactBody({ token: 't', id: 1 }, { allowFields: ['token', 'id'] }))
    .toEqual({ token: '[redacted]', id: 1 })
})

test('allowFields applies per element of an array body and drops bare primitives', () => {
  expect(redactBody([{ id: 1, notes: 'x' }], { allowFields: ['id'] })).toEqual([{ id: 1 }])
  expect(redactBody('raw secret text', { allowFields: ['id'] })).toBeUndefined()
})

// Review Focus: unserialisable values must not throw into application code
test('survives circular references, BigInt, functions and Errors', () => {
  const circular: any = { name: 'a' }; circular.self = circular
  expect(() => safeStringify(circular)).not.toThrow()
  expect(safeStringify(circular)).toContain('[circular]')
  expect(() => safeStringify({ n: 10n, fn: () => {}, err: new Error('boom') })).not.toThrow()
  expect(safeStringify({ err: new Error('boom') })).toContain('boom')
})

test('safeStringify renders BigInt as decimal, drops functions and symbols, keeps shared refs', () => {
  const shared = { v: 1 }
  expect(JSON.parse(safeStringify({ n: 10n, fn: () => {}, s: Symbol('x'), a: shared, b: shared })))
    .toEqual({ n: '10', a: { v: 1 }, b: { v: 1 } })
})

test('safeStringify never throws, even when a getter or toJSON throws or the top level is a function', () => {
  const bad = { get x(): number { throw new Error('nope') } }
  expect(() => safeStringify(bad)).not.toThrow()
  expect(() => JSON.parse(safeStringify(bad))).not.toThrow()
  expect(() => JSON.parse(safeStringify(() => {}))).not.toThrow()
  expect(() => JSON.parse(safeStringify(undefined))).not.toThrow()
})

// Review Focus: caps must be byte-based, not character-based
test('counts bytes, not characters, when deciding to truncate', () => {
  expect(byteLength('日本語')).toBe(9)
  const big = { note: '🎉'.repeat(3000) }            // 4 bytes each => ~12KB
  expect(truncateJson(big, 8192)).toEqual({ _truncated: true, _bytes: expect.any(Number) })
  expect((truncateJson(big, 8192) as any)._bytes).toBeGreaterThan(8192)
})

test('passes small bodies through untouched and keeps output valid JSON', () => {
  const small = { a: 1 }
  expect(truncateJson(small, 8192)).toEqual(small)
  expect(() => JSON.parse(safeStringify(truncateJson({ x: 'y'.repeat(99999) }, 8192)))).not.toThrow()
})

test('truncateJson defaults to 8192 bytes and is exact at the boundary', () => {
  const fits = 'a'.repeat(8190)                       // 8190 + 2 quotes = 8192
  expect(truncateJson(fits)).toBe(fits)
  expect(truncateJson(fits + 'a')).toEqual({ _truncated: true, _bytes: 8193 })
})

test('fixtures: entry is valid and tmp is a fresh empty directory', () => {
  const e = entry('hi')
  expect(e).toMatchObject({ level: 'info', msg: 'hi' })
  expect(new Date(e.ts).toISOString()).toBe(e.ts)
  expect(existsSync(tmp())).toBe(true)
  expect(tmp()).not.toBe(tmp())
})
