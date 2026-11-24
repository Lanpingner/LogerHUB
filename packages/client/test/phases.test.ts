import { runWithPhases, timePhase, startPhase, MAX_PHASES } from '../src/phases'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('records an async phase under its name', async () => {
  const ctx = runWithPhases(() => timePhase('db', () => sleep(20)))
  await ctx.result
  expect(ctx.phases().db).toBeGreaterThanOrEqual(15)
})

test('a sync function is returned directly, not wrapped in a promise', () => {
  const ctx = runWithPhases(() => timePhase('calc', () => 41 + 1))
  expect(ctx.result).toBe(42)              // not a Promise
  expect(ctx.phases().calc).toBeGreaterThanOrEqual(0)
})

test('repeated names sum into one entry', async () => {
  const ctx = runWithPhases(async () => {
    await timePhase('db', () => sleep(10))
    await timePhase('db', () => sleep(10))
  })
  await ctx.result
  expect(Object.keys(ctx.phases())).toEqual(['db'])
  expect(ctx.phases().db).toBeGreaterThanOrEqual(15)
})

test('a throwing function records its phase and rethrows', async () => {
  const ctx = runWithPhases(() => timePhase('db', async () => { await sleep(10); throw new Error('nope') }))
  await expect(ctx.result).rejects.toThrow('nope')
  expect(ctx.phases().db).toBeGreaterThanOrEqual(5)
})

test('a synchronously throwing function records its phase and rethrows', () => {
  const ctx = runWithPhases(() => {
    expect(() => timePhase('calc', () => { throw new Error('sync nope') })).toThrow('sync nope')
  })
  expect(ctx.phases().calc).toBeGreaterThanOrEqual(0)
})

test('outside a request context it runs the function and records nothing', async () => {
  let ran = false
  const value = await timePhase('db', async () => { ran = true; return 'value' })
  expect(value).toBe('value')
  expect(ran).toBe(true)
  // nothing leaked into a context opened afterwards
  expect(runWithPhases(() => undefined).phases()).toEqual({})
})

test('startPhase records once even if called twice', async () => {
  let done = () => {}
  const ctx = runWithPhases(async () => {
    done = startPhase('external')
    await sleep(10)
    done()
  })
  await ctx.result
  const first = ctx.phases().external
  await sleep(10)
  done()
  expect(Object.keys(ctx.phases())).toEqual(['external'])
  expect(ctx.phases().external).toBe(first)
})

// Review Focus 1
test('concurrent contexts do not mix phases', async () => {
  const a = runWithPhases(() => timePhase('a-only', () => sleep(20)))
  const b = runWithPhases(() => timePhase('b-only', () => sleep(20)))
  await Promise.all([a.result, b.result])
  expect(Object.keys(a.phases())).toEqual(['a-only'])
  expect(Object.keys(b.phases())).toEqual(['b-only'])
})

// Review Focus 4
test('rejects unusable names and truncates long ones', async () => {
  const ctx = runWithPhases(async () => {
    await timePhase('', () => sleep(1))
    await timePhase(123 as unknown as string, () => sleep(1))
    await timePhase('x'.repeat(500), () => sleep(1))
    await timePhase('server', () => sleep(1))       // reserved
  })
  await ctx.result
  const names = Object.keys(ctx.phases())
  expect(names).toEqual(['x'.repeat(64)])
})

// Review Focus 4 (ceiling)
test('the 17th distinct name is dropped and the first 16 survive', async () => {
  const ctx = runWithPhases(async () => {
    for (let i = 0; i < MAX_PHASES + 1; i++) await timePhase('p' + i, () => sleep(1))
  })
  await ctx.result
  expect(Object.keys(ctx.phases())).toHaveLength(MAX_PHASES)
  expect(ctx.phases()['p0']).toBeDefined()
  expect(ctx.phases()['p16']).toBeUndefined()
})

test('an existing name still accumulates once the ceiling is reached', async () => {
  const ctx = runWithPhases(async () => {
    for (let i = 0; i < MAX_PHASES; i++) await timePhase('p' + i, () => sleep(1))
    await timePhase('p0', () => sleep(10))
  })
  await ctx.result
  expect(Object.keys(ctx.phases())).toHaveLength(MAX_PHASES)
  expect(ctx.phases()['p0']).toBeGreaterThanOrEqual(5)
})
