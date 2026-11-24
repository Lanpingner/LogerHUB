# Request Timing Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the request duration into measured `server_ms` / `transit_ms`, and let applications report their own phases (`auth`, `db`, …) from anywhere in the call stack.

**Architecture:** The middleware patches `writeHead`/`write`/`end` to capture the first-byte timestamp, giving the split with no app changes. A separate `phases.ts` module holds one `AsyncLocalStorage` that the middleware enters per request, so `logger.time('db', fn)` works without `req` being threaded down. The split ships as scalar fields; app phases keep the existing `meta.http.timings` map so the console's waterfall renderer is reused unchanged.

**Tech Stack:** TypeScript, Node >= 24 (`node:async_hooks`), vitest, supertest, Express 4 and 5.

**Spec:** `docs/superpowers/specs/2026-11-24-request-timing-split-design.md`

## Global Constraints

- `duration_ms` keeps its current meaning and value: middleware entry → `res.finish`. No existing consumer changes behaviour.
- `server_ms` and `transit_ms` are scalar fields on `meta.http`, NOT keys in `meta.http.timings`. The inspector renders `timings` as one flat waterfall normalised by sum; `db` is inside `server`, so mixing them is arithmetically wrong.
- `meta.http.timings` keeps its current meaning: app-reported phases within server time.
- Measured values win over app-reported ones. The existing merge is `if (!Object.hasOwn(http, k))`; `server` and `transit` are additionally refused as phase names.
- At most **16** distinct phase names per request; further names are dropped, not added. Phase names are capped at **64** characters, matching the existing `dims` key ceiling.
- Repeated phase names **sum**. `timings` values must stay plain numbers — the existing renderer filters on `typeof v === 'number'`.
- Phases are self-reported totals, not a partition of server time: concurrent phases may sum to more than wall-clock.
- Outside a request context, `time()` runs the function and records nothing. It never throws for that reason.
- If a wrapped function throws, the phase is still recorded, then the error rethrows.
- No timing capture may cost the request: every capture path is wrapped so a throw inside it cannot reach the application. Follow the existing `guarded()` pattern in `middleware.ts`.
- A request aborted before any write omits both `server_ms` and `transit_ms` and keeps `duration_ms`.
- Terminal line default is `timing: 'split'`; `timing: 'total'` must reproduce the pinned original format byte for byte.
- Phases never appear on the terminal line.

## Review Focus

Five failure modes the spec implies but no task's happy-path test exercises. Each has its test assigned to the task that owns the code.

1. **Two concurrent requests must not mix phases.** `AsyncLocalStorage` is per-context, but a bug storing the map at module scope would pass every single-request test and silently merge traffic. → Task 1.
2. **A request that routes through Express's error handler** (`/throws`) still sends a first byte, so it must still produce a split rather than omitting it as if aborted. → Task 2.
3. **`res.end()` called twice** (the `/double-end` fixture exists for exactly this class of bug) must not move the first-byte mark or produce a negative `transit_ms`. → Task 2.
4. **A phase name that is not a string, is empty, or is 500 characters** must be rejected or truncated, never allowed to grow the map or reach the console as a giant key. → Task 1.
5. **`time()` with a synchronous function** must return its value directly and record immediately — not wrap it in a promise, which would change the caller's control flow. → Task 1.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/client/src/phases.ts` | **New.** The `AsyncLocalStorage`, the phase map, name validation, the ceiling. No HTTP knowledge. |
| `packages/client/src/middleware.ts` | First-byte capture; enters the phase context; emits the three timing fields. |
| `packages/client/src/types.ts` | `ConsoleConfig.timing`; `Logger.time` / `Logger.phase`. |
| `packages/client/src/logger.ts` | Wires `time` / `phase` onto the logger object. |
| `packages/client/src/console.ts` | Renders the split duration column. |
| `apps/web/src/components/RequestInspector.tsx` | `Server` and `Transit` fields beside `Total`. |

---

### Task 1: The phase context

**Files:**
- Create: `packages/client/src/phases.ts`
- Test: `packages/client/test/phases.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `runWithPhases<T>(fn: () => T): { result: T; phases: () => Record<string, number> }`
  - `timePhase<T>(name: string, fn: () => T): T` — returns `fn`'s value; if it is a promise, records on settle
  - `startPhase(name: string): () => void` — the returned function records elapsed; calling it twice records once
  - `MAX_PHASES = 16`, `MAX_PHASE_NAME = 64`, `RESERVED_PHASE_NAMES = ['server', 'transit']`

- [ ] **Step 1: Write the failing tests**

```ts
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

test('outside a request context it runs the function and records nothing', async () => {
  expect(await timePhase('db', () => sleep(1))).toBeUndefined()   // does not throw
})

test('startPhase records once even if called twice', async () => {
  const ctx = runWithPhases(async () => {
    const done = startPhase('external')
    await sleep(10)
    done()
    done()
  })
  await ctx.result
  expect(Object.keys(ctx.phases())).toEqual(['external'])
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
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run packages/client/test/phases.test.ts`
Expected: FAIL — cannot resolve `../src/phases`.

- [ ] **Step 3: Implement `packages/client/src/phases.ts`**

One module-level `AsyncLocalStorage<Map<string, number>>` from `node:async_hooks`. `runWithPhases` enters a fresh `Map` and returns both `fn`'s result and a reader that snapshots the map to a plain object.

`timePhase` measures with `process.hrtime.bigint()`. The one thing the signature does not determine: it must detect a thenable and attach recording to settle, while returning a non-thenable value synchronously — so the sync path records before returning and does not wrap.

Name handling, in order: reject non-strings and empty strings; reject `RESERVED_PHASE_NAMES`; truncate to `MAX_PHASE_NAME`; then, if the name is new and the map already holds `MAX_PHASES`, drop it — an existing name always accumulates.

- [ ] **Step 4: Run them and confirm they pass**

Run: `pnpm vitest run packages/client/test/phases.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/phases.ts packages/client/test/phases.test.ts
git commit -m "feat(client): per-request phase context over AsyncLocalStorage"
```

---

### Task 2: The measured server/transit split

**Files:**
- Modify: `packages/client/src/middleware.ts` (the `emit` body around line 171; the response patching near `captureResponse`)
- Test: `packages/client/test/middleware.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `meta.http.server_ms` and `meta.http.transit_ms` (numbers, both omitted together when no first byte was observed).

- [ ] **Step 1: Write the failing tests**

Append to `middleware.test.ts`, inside the existing `describe.each([4, 5])` block so both Express majors are covered.

```ts
test('splits duration into server and transit', async () => {
  const { app, entries } = await appWith({})
  await request(app).get('/slow').expect(200)       // see Step 3 for the fixture
  const http = (await entries())[0].meta.http
  expect(http.server_ms).toBeGreaterThanOrEqual(15)
  expect(http.transit_ms).toBeGreaterThanOrEqual(0)
  expect(http.server_ms + http.transit_ms).toBeCloseTo(http.duration_ms, 0)
})

test('a request aborted before any write has no split', async () => {
  const { app, entries } = await appWith({})
  // /hang never responds; abort the client side.
  const req = request(app).get('/hang').end(() => {})
  await sleep(50)
  req.abort()
  const http = (await entries())[0].meta.http
  expect(http.aborted).toBe(true)
  expect(http.server_ms).toBeUndefined()
  expect(http.transit_ms).toBeUndefined()
  expect(http.duration_ms).toBeGreaterThanOrEqual(0)
})

// Review Focus 2
test('a request through the error handler still has a split', async () => {
  const { app, entries } = await appWith({})
  await request(app).get('/throws').expect(500)
  const http = (await entries())[0].meta.http
  expect(http.server_ms).toBeGreaterThanOrEqual(0)
  expect(http.transit_ms).toBeGreaterThanOrEqual(0)
})

// Review Focus 3
test('a double end() does not move the mark or go negative', async () => {
  const { app, entries } = await appWith({})
  await request(app).get('/double-end').expect(200)
  const http = (await entries())[0].meta.http
  expect(http.transit_ms).toBeGreaterThanOrEqual(0)
  expect(http.server_ms).toBeGreaterThanOrEqual(0)
})

test('an explicit writeHead with no body still marks the first byte', async () => {
  const { app, entries } = await appWith({})
  await request(app).get('/head-only').expect(204)   // see Step 3 for the fixture
  const http = (await entries())[0].meta.http
  expect(http.server_ms).toBeGreaterThanOrEqual(0)
})

test('an app cannot overwrite the measurement via resolveMeta', async () => {
  const { app, entries } = await appWith({ resolveMeta: () => ({ server_ms: 999999 }) })
  await request(app).get('/users/1').expect(200)
  expect((await entries())[0].meta.http.server_ms).toBeLessThan(999999)
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run packages/client/test/middleware.test.ts -t 'split'`
Expected: FAIL — `server_ms` is `undefined`.

- [ ] **Step 3: Add the two fixtures**

In `packages/client/test/helpers/fixtures.ts`, beside the existing routes:
- `GET /slow` — waits ~25ms, then `res.json({ ok: true })`
- `GET /head-only` — `res.writeHead(204)` then `res.end()`

- [ ] **Step 4: Implement the first-byte capture in `packages/client/src/middleware.ts`**

Capture `firstByteAt: bigint | undefined` on the earliest of `writeHead`, `write`, `end`, set once and never overwritten — that is what makes the double-`end` and error-handler cases correct. Patch alongside the existing `captureResponse` wrapper, following its `guarded()` shape so a throw in the capture cannot reach the application.

In `emit`, add to `http` only when `firstByteAt !== undefined`:

```
server_ms  = Number(firstByteAt - start) / 1e6
transit_ms = Number(finishAt - firstByteAt) / 1e6
```

where `finishAt` is read once at the top of `emit`. Both are omitted together otherwise. They go in the measured block, before the `resolveMeta` merge, so the existing `Object.hasOwn` guard protects them.

- [ ] **Step 5: Run the whole client suite**

Run: `pnpm vitest run packages/client`
Expected: PASS, including the pre-existing duration and body-capture tests.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/middleware.ts packages/client/test/middleware.test.ts packages/client/test/helpers/fixtures.ts
git commit -m "feat(client): split request duration into server and transit time"
```

---

### Task 3: The `logger.time` / `logger.phase` API

**Files:**
- Modify: `packages/client/src/types.ts` (the `Logger` interface, after `printLine`)
- Modify: `packages/client/src/logger.ts` (the `self: Logger` object around line 590)
- Modify: `packages/client/src/middleware.ts` (wrap the downstream `next()` in the phase context; emit `timings`)
- Modify: `packages/client/README.md`
- Test: `packages/client/test/middleware.test.ts`

**Interfaces:**
- Consumes: `runWithPhases`, `timePhase`, `startPhase` from Task 1.
- Produces: on `Logger` —
  - `time<T>(name: string, fn: () => T): T`
  - `phase(name: string): () => void`

  and `meta.http.timings: Record<string, number>`, present only when at least one phase was recorded.

- [ ] **Step 1: Write the failing tests**

```ts
test('phases recorded during a request reach meta.http.timings', async () => {
  const { app, entries, log } = await appWith({})
  app.get('/phased', async (_req, res) => {
    await log.time('db', () => sleep(20))
    await log.time('render', () => sleep(5))
    res.json({ ok: true })
  })
  await request(app).get('/phased').expect(200)
  const http = (await entries()).at(-1)!.meta.http
  expect(http.timings.db).toBeGreaterThanOrEqual(15)
  expect(http.timings.render).toBeGreaterThanOrEqual(0)
  expect(http.timings.server).toBeUndefined()        // reserved, never a phase
})

test('a phase recorded without req, from a nested function, is still attributed', async () => {
  const { app, entries, log } = await appWith({})
  const repo = () => log.time('db', () => sleep(20))   // takes no req
  app.get('/nested', async (_req, res) => { await repo(); res.json({ ok: true }) })
  await request(app).get('/nested').expect(200)
  expect((await entries()).at(-1)!.meta.http.timings.db).toBeGreaterThanOrEqual(15)
})

test('timings is absent when the app records no phase', async () => {
  const { app, entries } = await appWith({})
  await request(app).get('/users/1').expect(200)
  expect((await entries())[0].meta.http.timings).toBeUndefined()
})

test('a phase outside any request does not throw and is not attributed', async () => {
  const { app, entries, log } = await appWith({})
  await log.time('orphan', () => sleep(1))             // no request in flight
  await request(app).get('/users/1').expect(200)
  expect((await entries())[0].meta.http.timings).toBeUndefined()
})

test('resolveMeta timings and recorded phases both survive', async () => {
  const { app, entries, log } = await appWith({ resolveMeta: () => ({ timings: { auth: 7 } }) })
  app.get('/both', async (_req, res) => { await log.time('db', () => sleep(10)); res.json({ ok: true }) })
  await request(app).get('/both').expect(200)
  const t = (await entries()).at(-1)!.meta.http.timings
  expect(t.db).toBeGreaterThanOrEqual(5)
  expect(t.auth).toBe(7)
})
```

The last test pins a real decision: recorded phases and `resolveMeta`-supplied `timings` must **merge**, with recorded phases winning on a key collision, rather than one replacing the other.

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run packages/client/test/middleware.test.ts -t 'phase'`
Expected: FAIL — `log.time is not a function`.

- [ ] **Step 3: Add `time` and `phase` to the `Logger` interface in `types.ts`**

Documented as: phases are self-reported totals within server time, not a partition — concurrent phases may sum to more than wall-clock. Name the 16-phase and 64-character ceilings in the doc comment.

- [ ] **Step 4: Implement them in `logger.ts`**

Delegate straight to `timePhase` / `startPhase`. A child logger shares them: the context is per-request, not per-logger instance, so `child()` needs no special handling.

- [ ] **Step 5: Enter the context in `middleware.ts`**

Wrap the downstream call so everything the request runs is inside `runWithPhases`. Read the phases in `emit` and set `http.timings` only when the map is non-empty, merging under the existing `resolveMeta` rules with recorded phases winning.

- [ ] **Step 6: Run the whole client suite**

Run: `pnpm vitest run packages/client`
Expected: PASS.

- [ ] **Step 7: Document both in `packages/client/README.md`**

A short section: `logger.time('db', fn)` with the nested-module example, `logger.phase` for awkward code, the ceilings, and the sentence that phases are self-reported totals rather than a partition.

- [ ] **Step 8: Commit**

```bash
git add packages/client/src packages/client/test packages/client/README.md
git commit -m "feat(client): logger.time and logger.phase for app-reported phases"
```

---

### Task 4: The split duration on the terminal line

**Files:**
- Modify: `packages/client/src/console.ts:242` (the `dur` column) and the `ConsoleConfig` read
- Modify: `packages/client/src/types.ts` (`ConsoleConfig.timing`)
- Test: `packages/client/test/line-format.test.ts`

**Interfaces:**
- Consumes: `meta.http.server_ms` / `transit_ms` from Task 2.
- Produces: `ConsoleConfig.timing?: 'split' | 'total'`, default `'split'`.

- [ ] **Step 1: Write the failing tests**

```ts
test('the split duration renders as server+transit', () => {
  // entry with server_ms: 12.4, transit_ms: 3.1
  expect(line).toMatch(/^\d\d:\d\d:\d\d +12ms\+3ms GET {4} \[a1b2c3d4\] \/users\/1 — 200$/)
})

test("timing: 'total' reproduces the pinned original format byte for byte", () => {
  // the same entry, with timing: 'total'
  expect(line).toMatch(
    /^\d\d:\d\d:\d\d +\+\d+ms GET {4} \[APR\] \[a1b2c3d4\] \/users\/1 from 127\.0\.0\.1 app:OFF ip-exc user:42 — 200 \(cached\)$/,
  )
})

test('falls back to the total when the split is absent', () => {
  // entry with duration_ms only — an older client, or an aborted request
  expect(line).toMatch(/^\d\d:\d\d:\d\d +\+\d+ms GET/)
})

test('the duration column is a fixed width across split and fallback lines', () => {
  // two entries, one split one not: the method must start at the same column
  expect(colOf(splitLine, 'GET')).toBe(colOf(totalLine, 'GET'))
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run packages/client/test/line-format.test.ts`
Expected: FAIL — the split line renders `+15ms`.

- [ ] **Step 3: Add `timing` to `ConsoleConfig` in `types.ts`**

Doc comment must say that `'total'` is the original pinned format and `'split'` widens the duration column.

- [ ] **Step 4: Implement the column in `console.ts`**

`'split'` with both fields present renders `Nms+Nms` rounded; anything else keeps `+Nms`. One fixed `padStart` width for both, chosen so the existing fallback still fits, and asserted by the Step 1 width test. Non-request lines (`console.ts:164`) are untouched.

- [ ] **Step 5: Run the console and pending-block suites**

Run: `pnpm vitest run packages/client/test/line-format.test.ts packages/client/test/console.test.ts packages/client/test/pending-block.test.ts`
Expected: PASS. Pre-existing pinned-format tests must be updated only by adding `timing: 'total'` to their config — if a pinned assertion needs its regex changed, that is a signal the column logic is wrong.

- [ ] **Step 6: Document the option in `packages/client/README.md`**

Including the one-word restoration of the original format.

- [ ] **Step 7: Commit**

```bash
git add packages/client/src packages/client/test packages/client/README.md
git commit -m "feat(client): render the server/transit split on the terminal line"
```

---

### Task 5: Server and Transit in the console inspector

**Files:**
- Modify: `apps/web/src/components/RequestInspector.tsx:90-120` (the `Timing` component)

**Interfaces:**
- Consumes: `meta.http.server_ms` / `transit_ms`, read via the existing `http(row)` helper. No change to `LogRow`, `server-queries.ts` or `LiveConsole.tsx` — the component reads `meta.http` directly.
- Produces: nothing.

- [ ] **Step 1: Add the fields**

Beside the existing `Total` field, in both branches of `Timing` (with and without a phase waterfall): `Server` and `Transit`, each rendered with the existing `LatencyIndicator` and each shown only when its value is a number. An older entry with neither shows exactly what it shows today.

- [ ] **Step 2: Update the placeholder copy**

The "No phase breakdown was sent with this request" text currently says to report `meta.http.timings` by hand. It should now name the API: `logger.time('db', fn)`. The split fields above it are present regardless, so the copy must not imply the whole timing section is empty.

- [ ] **Step 3: Typecheck and build**

Run: `pnpm --filter @logguber/web typecheck && pnpm --filter @logguber/web build`
Expected: PASS.

- [ ] **Step 4: Verify in the real console**

Start the stack, send one request carrying a phase through a client pointed at it, open the request in the inspector, and confirm: `Total`, `Server`, `Transit` all populated, and the waterfall showing the phase. A screenshot or the observed values go in the task report — this is the only task whose deliverable is visual, so a passing typecheck is not evidence it works.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/RequestInspector.tsx
git commit -m "feat(web): show server and transit time in the request inspector"
```

---

### Task 6: Detect CORS preflights

**Files:**
- Modify: `packages/client/src/middleware.ts` (the `emit` body, beside the other measured fields)
- Test: `packages/client/test/middleware.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `'preflight'` as an entry in `meta.http.flags`. The console already renders each `flags` entry as a bare word on the line, so no rendering change is needed in either console.

A CORS preflight is exactly three conditions together, per the Fetch spec: the method is `OPTIONS`, an `Origin` header is present, and an `Access-Control-Request-Method` header is present. The third is what distinguishes a preflight from a plain `OPTIONS` (a health probe, `curl -X OPTIONS`), so the detection never guesses. Node lowercases incoming header names, so no case handling is required.

Preflights stay in request counts and latency percentiles — flagged, not special-cased. That was the operator's explicit choice, so a later task must not quietly exclude them.

- [ ] **Step 1: Write the failing tests**

```ts
test('a CORS preflight is flagged', async () => {
  const { app, entries } = await appWith({})
  await request(app)
    .options('/users/1')
    .set('Origin', 'https://example.com')
    .set('Access-Control-Request-Method', 'GET')
  expect((await entries())[0].meta.http.flags).toContain('preflight')
})

test('a plain OPTIONS is not flagged', async () => {
  const { app, entries } = await appWith({})
  await request(app).options('/users/1')
  const flags = (await entries())[0].meta.http.flags
  expect(flags === undefined || !flags.includes('preflight')).toBe(true)
})

test('OPTIONS with an Origin but no Access-Control-Request-Method is not flagged', async () => {
  const { app, entries } = await appWith({})
  await request(app).options('/users/1').set('Origin', 'https://example.com')
  const flags = (await entries())[0].meta.http.flags
  expect(flags === undefined || !flags.includes('preflight')).toBe(true)
})

test('a GET carrying an Origin is not flagged', async () => {
  const { app, entries } = await appWith({})
  await request(app).get('/users/1').set('Origin', 'https://example.com').expect(200)
  const flags = (await entries())[0].meta.http.flags
  expect(flags === undefined || !flags.includes('preflight')).toBe(true)
})

test("an app's own flags survive alongside the preflight flag", async () => {
  const { app, entries } = await appWith({ resolveMeta: () => ({ flags: ['ip-exc'] }) })
  await request(app)
    .options('/users/1')
    .set('Origin', 'https://example.com')
    .set('Access-Control-Request-Method', 'GET')
  expect((await entries())[0].meta.http.flags).toEqual(expect.arrayContaining(['ip-exc', 'preflight']))
})

test('preflights still count as requests', async () => {
  const { app, entries } = await appWith({})
  await request(app).options('/users/1').set('Origin', 'https://e.com').set('Access-Control-Request-Method', 'GET')
  expect((await entries())[0].kind).toBe('request')
})
```

The fifth test pins a real decision: `flags` must **merge** rather than be replaced. The existing `resolveMeta` guard is `if (!Object.hasOwn(http, k))`, which would silently drop the measured flag whenever an app supplies its own — the same hazard as `timings` in Task 3, and it needs the same explicit merge.

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run packages/client/test/middleware.test.ts -t 'preflight'`
Expected: FAIL — `flags` is `undefined`.

- [ ] **Step 3: Implement the detection in `middleware.ts`**

A small predicate over `req.method` and the two headers, then push `'preflight'` into `http.flags`, merging with any app-supplied array and de-duplicating.

- [ ] **Step 4: Run the whole client suite**

Run: `pnpm vitest run packages/client`
Expected: PASS.

- [ ] **Step 5: Document it in `packages/client/README.md`**

One line under the request-line fields: what `preflight` means, the three conditions, and that preflights are counted like any other request.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/middleware.ts packages/client/test/middleware.test.ts packages/client/README.md
git commit -m "feat(client): flag CORS preflight requests"
```

---

## Self-review notes

- **Spec coverage.** Part 1 → Task 2 (+ Task 4 rendering). Part 2 → Tasks 1 and 3. Console → Task 5. The data-shape constraint that drove the design (no `server`/`transit` inside `timings`) is pinned by a test in Task 3 and by the reserved-name test in Task 1.
- **Deliberately not built,** per the spec's non-goals: nginx `X-Request-Start` (`wait_ms`), split percentile charts, `server:`/`transit:` query filters, per-phase call counts.
- **Ordering.** Task 2 is independent of Task 1 and could run first or in parallel; Tasks 3, 4 and 5 each depend on an earlier task's field names, which are fixed in the Interfaces blocks.
