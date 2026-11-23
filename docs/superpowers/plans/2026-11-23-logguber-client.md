# Logguber Client Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@logguber/client`, the npm package Express services use to stream logs to the Logguber gateway over WebSocket, spooling to local SQLite whenever the gateway is unreachable.

**Architecture:** Log calls enqueue into an in-memory batcher that cuts batches on size or time. Batches go out over one persistent WebSocket and are held until the gateway acks them. When the socket is down or a batch goes unacked, the batch is written to a local SQLite spool and replayed oldest-first on reconnect. Redaction of headers and body fields happens before anything is queued, so secrets never reach the network or the disk.

**Tech Stack:** TypeScript, Node 22+, `ws`, `better-sqlite3`, `ulid`, vitest, tsup (dual ESM/CJS), pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-11-23-logguber-design.md`

## Global Constraints

- Node.js 22+. TypeScript throughout. Package builds to both ESM and CommonJS.
- Nothing in the client may throw into application code. Every internal failure goes to the `onError` hook, which defaults to one rate-limited `console.warn`.
- Log calls are synchronous and non-blocking: they enqueue and return.
- Batch defaults: cut at 100 entries or 1000ms, whichever first. Overridden downward by the server's `hello` limits.
- Server `hello` fields: `maxEntriesPerBatch`, `maxBatchBytes`, `ackWindow`. At most `ackWindow` batches in flight.
- Batch ids are ULIDs, stable across every retransmission of the same batch.
- WebSocket close codes 4401 and 4403 are permanent: stop reconnecting, report loudly. All other closes are transient and retried with exponential backoff plus jitter.
- Spool is used only while the gateway is unreachable (`mode: 'on-failure'`, the default). `mode: 'always'` writes every batch to disk before sending.
- Spool bounds: `maxBytes` 256MB, `maxAge` 7 days. On overflow prune oldest, count pruned entries, report the count to the gateway on the next successful batch.
- Body truncation cap: 8KB of serialised JSON per body, replaced with `{"_truncated": true, "_bytes": <n>}`. Truncation happens at a structural boundary so the result is still valid JSON.
- Header capture is allowlist-only. Default allowlist: `host`, `user-agent`, `content-type`, `content-length`, `accept`, `referer`, `x-request-id`.
- Default redacted body keys, at any depth. Keys are normalised by lowercasing and stripping non-alphanumerics, then matched (a) exactly against `password`, `pass`, `token`, `secret`, `apikey`, `api_key`, `authorization`, `credential`, `card`, `cardnumber`, `cvv`, `ssn`, `otp`, `refresh_token`, and (b) by substring against `password`, `secret`, `token`, `credential`, `apikey`, `privatekey` — never a bare `key`. Replacement value is the string `[redacted]`. A caller's `redactKeys` extends these defaults and never replaces them; narrowing is done with `allowFields`.
- Body capture modes: `never`, `on-error` (default), `sample`, `always`.
- Loki ceilings the client must respect: 128 structured-metadata entries, 64KB structured metadata per line, 256KB per line.
- Entry levels: `debug`, `info`, `warn`, `error`, `fatal`. Unknown levels coerce to `info`.
- SQLite opened in WAL mode with a busy timeout; spool rows claimed inside a transaction so concurrent workers never send the same batch twice.
- SQLite binding is the built-in `node:sqlite` (see ledger ruling R1), keeping the package dependency-free of native modules. Package Node floor is therefore 24+.
- Unspecified defaults, fixed here: `batch.maxQueue` 10000 entries; `truncateJson` maxBytes 8192; transport `ackTimeoutMs` 30000; transport backoff `baseMs` 500, `maxMs` 30000.
- Wire types (`LogEntry`, `BatchFrame`, frames, limits) are defined once in `@logguber/shared` and re-exported by the client. `packages/client/src/types.ts` holds only client-facing option types and never redefines a wire type.
- `expressMiddleware` is a `Logger` method. `middleware.ts` exports `createExpressMiddleware(logger, opts)`; `logger.expressMiddleware(opts)` delegates to it. Both names are fixed — do not introduce a third.
- `Logger.log(level: string, msg: string, opts?)` is public, accepts any string, and coerces unknown levels to `info`. The named level methods delegate to it.

## Review Focus

Input classes the spec implies but that no task's happy path exercises. Each has a test added to the task that owns the code.

- **Unserialisable values in `dims` or a body** — circular references, `BigInt`, functions, `Error` instances. `JSON.stringify` throws on these; a logger that throws inside `log.info()` takes down the request it was logging. Must degrade to a placeholder. (Task 2)
- **Spool directory unwritable or database corrupt** — read-only filesystem, missing permissions, truncated file. The client must fall back to memory-only and report, never crash at construction. (Task 4)
- **A batch that is never acked** — gateway accepts the frame then goes silent. Without a per-batch timeout, in-flight slots leak until the client wedges and stops sending entirely. (Task 5)
- **Byte versus character length** — multi-byte UTF-8 (CJK, emoji) in bodies and messages. Size caps computed on `string.length` under-count by up to 4x and let Loki's 256KB limit be breached, which drops the line. (Task 2)
- **Array-valued and non-string headers** — Node gives `set-cookie` as an array and `Content-Length` as a number. Naive lowercase-and-copy produces wrong types or crashes on `.toLowerCase()` of a non-string. (Task 7)

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json` | Workspace root |
| `packages/shared/src/protocol.ts` | Wire frame types, `hello` defaults, level list, limit constants |
| `packages/shared/src/canonical.ts` | Canonical JSON for dimension maps (sorted keys, `unknown` filling) |
| `packages/client/src/types.ts` | Public option and entry types |
| `packages/client/src/redact.ts` | Header allowlisting, body key redaction, safe serialisation, truncation |
| `packages/client/src/batcher.ts` | In-memory queue, batch cutting, bounded size, drop accounting |
| `packages/client/src/spool.ts` | SQLite spool: push, claim, ack, prune |
| `packages/client/src/transport.ts` | WebSocket connection, handshake, acks, reconnect, ack window |
| `packages/client/src/logger.ts` | Wires batcher → transport → spool; public logger surface |
| `packages/client/src/middleware.ts` | Express request/response logging and body capture |
| `packages/client/src/sink.ts` | Low-level `createSink()` for pino/winston adapters |
| `packages/client/src/index.ts` | Public exports |
| `packages/client/test/helpers/stub-gateway.ts` | Controllable WebSocket server for tests |
| `packages/client/test/helpers/fixtures.ts` | Shared test helpers (created in Task 2, extended as later tasks need) |

**Shared test helpers.** The test code below uses these throughout; create them in
`test/helpers/fixtures.ts` in Task 2 and extend them as later tasks require:

- `entry(msg: string): LogEntry` — a valid entry with `level: 'info'` and the current timestamp.
- `batch(id: string, pad?: string): BatchFrame` — a one-entry batch with that id.
- `tmp(): string` — a fresh empty directory under `os.tmpdir()`, removed after the suite.
- `waitFor(fn: () => boolean, timeoutMs = 1000): Promise<void>` — polls until true or throws.
- `sleep(ms: number): Promise<void>`.
- `base` — `{ apiKey: 'lgb_test_secret', service: 'public-api', env: 'test', onError: () => {} }`, spread into `createTransport`/`createLogger` options.
- `appWith(opts: MiddlewareOptions)` — added in Task 7: an Express app with routes `/users/:id` (200), `/missing` (404), `/boom` (500), `/echo` (200, echoes JSON), `/fail` (500), `/stream` (writes `a`, `b`, `c` then ends), the middleware installed, and an `entries` array collecting what the logger emitted.

---

## Task 1: Workspace and wire protocol

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`
- Create: `packages/shared/package.json`, `packages/shared/src/protocol.ts`, `packages/shared/src/canonical.ts`, `packages/shared/src/index.ts`
- Create: `packages/client/package.json`, `packages/client/tsconfig.json`, `vitest.config.ts`
- Test: `packages/shared/test/canonical.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `LEVELS: readonly ['debug','info','warn','error','fatal']`; `HELLO_DEFAULTS: { maxEntriesPerBatch: 500; maxBatchBytes: 1048576; ackWindow: 8 }`; `LOKI_LIMITS: { maxLineBytes: 262144; maxMetadataEntries: 128; maxMetadataBytes: 65536 }`; types `Level`, `LogEntry { ts: string; level: Level; kind?: 'request'; msg: string; dims?: Record<string,string>; meta?: Record<string, unknown> }`, `BatchFrame { t: 'batch'; id: string; entries: LogEntry[]; droppedSinceLast?: number }`, `AckFrame { t: 'ack'; id: string }`, `NackFrame { t: 'nack'; id: string; reason: string; retryable: boolean }`, `HelloFrame { t: 'hello'; maxEntriesPerBatch: number; maxBatchBytes: number; ackWindow: number }`, `ServerFrame = HelloFrame | AckFrame | NackFrame`; `canonicalDims(dims: Record<string,string|undefined>, levels: string[]): string`.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/shared`
Expected: FAIL — cannot resolve `../src/canonical`.

- [ ] **Step 3: Set up the workspace**

Root `package.json` with `packageManager: pnpm`, scripts `test` (vitest run), `build` (tsup in each package), `typecheck`. `pnpm-workspace.yaml` listing `packages/*`. `tsconfig.base.json` with `strict: true`, `target: ES2022`, `module: NodeNext`. Both packages private initially, `@logguber/client` depending on `@logguber/shared` via `workspace:*`.

- [ ] **Step 4: Implement `canonicalDims(dims, levels)` in `packages/shared/src/canonical.ts` and the constants and types above in `packages/shared/src/protocol.ts`**

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run packages/shared`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: pnpm workspace and Logguber wire protocol types"
```

---

## Task 2: Redaction, safe serialisation, and truncation

The highest-value task in the package: a miss here ships credentials into the log store.

**Files:**
- Create: `packages/client/src/redact.ts`, `packages/client/src/types.ts`
- Test: `packages/client/test/redact.test.ts`

**Interfaces:**
- Consumes: Task 1 constants.
- Produces:
  - `DEFAULT_HEADER_ALLOWLIST: string[]` and `DEFAULT_REDACT_KEYS: string[]` (exact values in Global Constraints).
  - `redactHeaders(headers: unknown, allowlist?: string[]): Record<string,string>`
  - `redactBody(value: unknown, opts?: { redactKeys?: string[]; allowFields?: string[] }): unknown`
  - `safeStringify(value: unknown): string` — never throws.
  - `truncateJson(value: unknown, maxBytes?: number): unknown` — returns the value when it serialises within `maxBytes`, otherwise `{ _truncated: true, _bytes: n }`.
  - `byteLength(s: string): number`

- [ ] **Step 1: Write the failing tests**

```ts
test('captures only allowlisted headers, whatever case they arrive in', () => {
  const out = redactHeaders({
    Host: 'api.example.com', 'Content-Type': 'application/json',
    Authorization: 'Bearer secret', Cookie: 'sid=abc', 'X-Api-Key': 'k',
  })
  expect(out).toEqual({ host: 'api.example.com', 'content-type': 'application/json' })
})

test('redacts secret-bearing keys at any depth, case-insensitively', () => {
  expect(redactBody({ user: { Password: 'hunter2', name: 'ro' }, api_key: 'k' }))
    .toEqual({ user: { Password: '[redacted]', name: 'ro' }, api_key: '[redacted]' })
})

test('walks arrays of objects', () => {
  expect(redactBody({ items: [{ token: 't1' }, { token: 't2' }] }))
    .toEqual({ items: [{ token: '[redacted]' }, { token: '[redacted]' }] })
})

test('allowFields mode captures nothing but the named fields', () => {
  expect(redactBody({ orderId: 'o1', status: 'paid', notes: 'private' },
                    { allowFields: ['orderId', 'status'] }))
    .toEqual({ orderId: 'o1', status: 'paid' })
})

// Review Focus: unserialisable values must not throw into application code
test('survives circular references, BigInt, functions and Errors', () => {
  const circular: any = { name: 'a' }; circular.self = circular
  expect(() => safeStringify(circular)).not.toThrow()
  expect(safeStringify(circular)).toContain('[circular]')
  expect(() => safeStringify({ n: 10n, fn: () => {}, err: new Error('boom') })).not.toThrow()
  expect(safeStringify({ err: new Error('boom') })).toContain('boom')
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/client/test/redact.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

`safeStringify` uses a `JSON.stringify` replacer holding a `WeakSet` for cycles (emitting `'[circular]'`), converting `BigInt` to its decimal string, `Error` to `{ name, message }`, and dropping functions and symbols. `redactBody` recurses over plain objects and arrays, leaves other values alone, and matches keys by lowercased name. `byteLength` uses `Buffer.byteLength`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/client/test/redact.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/redact.ts packages/client/src/types.ts packages/client/test/redact.test.ts
git commit -m "feat(client): header allowlisting, body redaction and safe serialisation"
```

---

## Task 3: Batcher

**Files:**
- Create: `packages/client/src/batcher.ts`
- Test: `packages/client/test/batcher.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces: `createBatcher(opts: { maxEntries: number; maxMs: number; maxQueue: number; onBatch: (entries: LogEntry[], droppedSinceLast: number) => void }): { push(e: LogEntry): void; flush(): void; setLimits(l: { maxEntriesPerBatch: number }): void; stats(): { queued: number; dropped: number }; close(): void }`

- [ ] **Step 1: Write the failing tests**

```ts
beforeEach(() => vi.useFakeTimers())

test('cuts a batch once maxEntries is reached, without waiting for the timer', () => {
  const onBatch = vi.fn()
  const b = createBatcher({ maxEntries: 3, maxMs: 1000, maxQueue: 100, onBatch })
  for (let i = 0; i < 3; i++) b.push(entry(`m${i}`))
  expect(onBatch).toHaveBeenCalledTimes(1)
  expect(onBatch.mock.calls[0][0]).toHaveLength(3)
})

test('cuts a partial batch when maxMs elapses', () => {
  const onBatch = vi.fn()
  const b = createBatcher({ maxEntries: 100, maxMs: 1000, maxQueue: 100, onBatch })
  b.push(entry('one'))
  expect(onBatch).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1000)
  expect(onBatch).toHaveBeenCalledTimes(1)
})

test('drops oldest beyond maxQueue and reports the count with the next batch', () => {
  const onBatch = vi.fn()
  // maxEntries high so nothing drains before flush; maxQueue is what bites
  const b = createBatcher({ maxEntries: 100, maxMs: 10_000, maxQueue: 2, onBatch })
  for (const m of ['a', 'b', 'c', 'd', 'e']) b.push(entry(m))
  b.flush()
  const [entries, dropped] = onBatch.mock.calls.at(-1)!
  expect(dropped).toBe(3)
  expect(entries.map((e: any) => e.msg)).toEqual(['d', 'e'])
})

test('reports a drop count once, then resets it', () => {
  const onBatch = vi.fn()
  const b = createBatcher({ maxEntries: 100, maxMs: 10_000, maxQueue: 1, onBatch })
  b.push(entry('a')); b.push(entry('b')); b.flush()
  expect(onBatch.mock.calls.at(-1)![1]).toBe(1)
  b.push(entry('c')); b.flush()
  expect(onBatch.mock.calls.at(-1)![1]).toBe(0)
})

test('setLimits lowers the cut size when the server asks for smaller batches', () => {
  const onBatch = vi.fn()
  const b = createBatcher({ maxEntries: 100, maxMs: 1000, maxQueue: 100, onBatch })
  b.setLimits({ maxEntriesPerBatch: 2 })
  b.push(entry('a')); b.push(entry('b'))
  expect(onBatch).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/client/test/batcher.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `createBatcher` in `packages/client/src/batcher.ts`**

The dropped counter resets to zero once it has been handed to `onBatch`, so a count is reported exactly once.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/client/test/batcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/batcher.ts packages/client/test/batcher.test.ts
git commit -m "feat(client): bounded batching queue with drop accounting"
```

---

## Task 4: SQLite spool

**Files:**
- Create: `packages/client/src/spool.ts`
- Test: `packages/client/test/spool.test.ts`

**Interfaces:**
- Consumes: Task 1 `BatchFrame`.
- Produces: `createSpool(opts: { dir: string; maxBytes?: number; maxAge?: number; onError?: (e: Error) => void }): Spool` where `Spool = { push(batch: BatchFrame): void; claim(n: number): Array<{ id: string; batch: BatchFrame }>; ack(id: string): void; release(id: string): void; prune(): number; count(): number; prunedCount(): number; available(): boolean; close(): void }`

Schema: `spool(id TEXT PRIMARY KEY, body BLOB NOT NULL, created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, claimed_at INTEGER)`, plus an index on `created_at`. WAL mode, `busy_timeout = 5000`.

- [ ] **Step 1: Write the failing tests**

```ts
test('round-trips a batch and deletes it only on ack', () => {
  const s = createSpool({ dir: tmp() })
  s.push({ t: 'batch', id: '01A', entries: [entry('hello')] })
  expect(s.count()).toBe(1)
  const [claimed] = s.claim(10)
  expect(claimed.batch.entries[0].msg).toBe('hello')
  expect(s.count()).toBe(1)                 // still present until acked
  s.ack('01A')
  expect(s.count()).toBe(0)
})

test('claims oldest first and does not hand the same row to a second caller', () => {
  const s = createSpool({ dir: tmp() })
  s.push(batch('01A')); s.push(batch('01B'))
  expect(s.claim(1)[0].id).toBe('01A')
  expect(s.claim(1)[0].id).toBe('01B')
  expect(s.claim(1)).toHaveLength(0)
})

test('release returns a claimed row for retry and counts the attempt', () => {
  const s = createSpool({ dir: tmp() })
  s.push(batch('01A')); s.claim(1); s.release('01A')
  expect(s.claim(1)[0].id).toBe('01A')
})

test('prunes oldest rows past maxBytes and counts what it dropped', () => {
  const s = createSpool({ dir: tmp(), maxBytes: 2000 })
  for (let i = 0; i < 50; i++) s.push(batch(`id${i}`, 'x'.repeat(200)))
  expect(s.prunedCount()).toBeGreaterThan(0)
  expect(s.claim(1)[0].id).not.toBe('id0')
})

test('prunes rows older than maxAge', () => {
  vi.useFakeTimers()
  const s = createSpool({ dir: tmp(), maxAge: 1000 })
  s.push(batch('old'))
  vi.advanceTimersByTime(5000)
  expect(s.prune()).toBe(1)
  vi.useRealTimers()
})

// Review Focus: an unwritable directory must degrade, not crash
test('falls back to unavailable instead of throwing when the directory cannot be written', () => {
  const ro = tmp(); fs.chmodSync(ro, 0o400)
  const onError = vi.fn()
  const s = createSpool({ dir: ro, onError })
  expect(s.available()).toBe(false)
  expect(() => s.push(batch('01A'))).not.toThrow()
  expect(onError).toHaveBeenCalled()
})

// Review Focus: a corrupt database file must not wedge startup
test('recreates the database when the file is not valid SQLite', () => {
  const dir = tmp(); fs.writeFileSync(path.join(dir, 'spool.db'), 'not a database')
  const s = createSpool({ dir, onError: () => {} })
  expect(() => s.push(batch('01A'))).not.toThrow()
  expect(s.available()).toBe(true)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/client/test/spool.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `createSpool`**

Wrap construction in try/catch: on failure report via `onError` and return a no-op spool whose `available()` is false. On a corrupt file, unlink and retry once before giving up. `claim` sets `claimed_at` inside a transaction and selects only rows where `claimed_at IS NULL`, ordered by `created_at`. Size accounting uses the summed `length(body)` rather than the file size, so pruning is deterministic in tests.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/client/test/spool.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/spool.ts packages/client/test/spool.test.ts
git commit -m "feat(client): SQLite spool with claim/ack, bounds and corruption recovery"
```

---

## Task 5: WebSocket transport

**Files:**
- Create: `packages/client/src/transport.ts`, `packages/client/test/helpers/stub-gateway.ts`
- Test: `packages/client/test/transport.test.ts`

**Interfaces:**
- Consumes: Task 1 frame types and `HELLO_DEFAULTS`.
- Produces:
  - `createStubGateway(opts?: { onBatch?: (b: BatchFrame, c: StubConn) => void; hello?: Partial<HelloFrame>; rejectWith?: number }): Promise<{ url: string; batches: BatchFrame[]; conns: StubConn[]; close(): Promise<void>; stop(): Promise<void>; start(): Promise<void> }>` — `stop()` kills the server while keeping its port so a reconnect can succeed later.
  - `createTransport(opts: { url: string; apiKey: string; service: string; env: string; onAck: (id: string) => void; onNack: (f: NackFrame) => void; onState: (s: 'connecting'|'open'|'closed'|'fatal') => void; onError: (e: Error) => void; ackTimeoutMs?: number; backoff?: { baseMs: number; maxMs: number } }): { send(b: BatchFrame): boolean; inFlight(): number; state(): string; close(): Promise<void> }`

`send` returns false when the ack window is full or the socket is not open, which is the caller's signal to spool instead.

- [ ] **Step 1: Write the failing tests**

```ts
test('sends service, env and bearer key on the handshake', async () => {
  const g = await createStubGateway()
  const t = createTransport({ ...base, url: g.url })
  await waitFor(() => t.state() === 'open')
  const req = g.conns[0].request
  expect(req.url).toContain('service=public-api')
  expect(req.url).toContain('env=test')
  expect(req.headers.authorization).toBe('Bearer lgb_test_secret')
})

test('refuses to send beyond the ack window until acks arrive', async () => {
  const g = await createStubGateway({ hello: { ackWindow: 2 }, onBatch: () => {} }) // never acks
  const t = createTransport({ ...base, url: g.url })
  await waitFor(() => t.state() === 'open')
  expect(t.send(batch('1'))).toBe(true)
  expect(t.send(batch('2'))).toBe(true)
  expect(t.send(batch('3'))).toBe(false)
  expect(t.inFlight()).toBe(2)
})

test('frees the slot when an ack arrives', async () => {
  const g = await createStubGateway()   // acks everything
  const t = createTransport({ ...base, url: g.url })
  await waitFor(() => t.state() === 'open')
  t.send(batch('1'))
  await waitFor(() => t.inFlight() === 0)
})

test('treats 4401 and 4403 as fatal and stops reconnecting', async () => {
  const g = await createStubGateway({ rejectWith: 4401 })
  const onState = vi.fn()
  const t = createTransport({ ...base, url: g.url, onState })
  await waitFor(() => t.state() === 'fatal')
  const attempts = g.conns.length
  await sleep(200)
  expect(g.conns.length).toBe(attempts)        // no further attempts
})

test('reconnects with backoff after a transient close', async () => {
  const g = await createStubGateway()
  const t = createTransport({ ...base, url: g.url, backoff: { baseMs: 10, maxMs: 50 } })
  await waitFor(() => t.state() === 'open')
  await g.stop()
  await waitFor(() => t.state() !== 'open')
  await g.start()
  await waitFor(() => t.state() === 'open', 3000)
})

// Review Focus: a batch the gateway never acks must not leak its in-flight slot
test('reclaims the slot when an ack never arrives', async () => {
  const g = await createStubGateway({ hello: { ackWindow: 1 }, onBatch: () => {} })
  const t = createTransport({ ...base, url: g.url, ackTimeoutMs: 50 })
  await waitFor(() => t.state() === 'open')
  expect(t.send(batch('1'))).toBe(true)
  expect(t.send(batch('2'))).toBe(false)
  await waitFor(() => t.inFlight() === 0, 1000)   // timed out and released
  expect(t.send(batch('2'))).toBe(true)
})

test('reports a non-retryable nack without reconnecting', async () => {
  const g = await createStubGateway({ onBatch: (b, c) =>
    c.send({ t: 'nack', id: b.id, reason: 'malformed', retryable: false }) })
  const onNack = vi.fn()
  const t = createTransport({ ...base, url: g.url, onNack })
  await waitFor(() => t.state() === 'open')
  t.send(batch('1'))
  await waitFor(() => onNack.mock.calls.length === 1)
  expect(onNack.mock.calls[0][0].retryable).toBe(false)
  expect(t.state()).toBe('open')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/client/test/transport.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the stub gateway and `createTransport`**

Stub uses `ws`'s `WebSocketServer` on an ephemeral port, records each upgrade request, sends `hello` on connect, and acks every batch unless `onBatch` is supplied. `rejectWith` closes with that code immediately after upgrade.

Transport tracks in-flight batch ids in a `Map<string, timer>`; an expired timer releases the slot and surfaces the id through `onNack` with `retryable: true` so the caller can respool it. Backoff is `min(maxMs, baseMs * 2 ** attempt)` with full jitter. Reaching state `fatal` clears all reconnect timers.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/client/test/transport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/transport.ts packages/client/test/
git commit -m "feat(client): acked WebSocket transport with ack window and backoff"
```

---

## Task 6: Logger wiring

Where batcher, transport, and spool become one object. The outage test here is the reason the spool exists.

**Files:**
- Create: `packages/client/src/logger.ts`, `packages/client/src/sink.ts`, `packages/client/src/index.ts`
- Test: `packages/client/test/logger.test.ts`, `packages/client/test/outage.test.ts`

**Interfaces:**
- Consumes: Tasks 2-5.
- Produces:
  - `createLogger(opts: LoggerOptions): Logger` where `LoggerOptions = { url: string; apiKey: string; service: string; env: string; spool?: { dir: string; mode?: 'on-failure'|'always'; maxBytes?: number; maxAge?: number }; batch?: { maxEntries?: number; maxMs?: number; maxQueue?: number }; dims?: Record<string,string>; redactKeys?: string[]; headerAllowlist?: string[]; onError?: (e: Error) => void }`
  - `Logger = { debug; info; warn; error; fatal: (msg: string, opts?: { dims?: Record<string,string>; meta?: Record<string, unknown> }) => void; child(opts: { dims?: Record<string,string> }): Logger; expressMiddleware(o?: MiddlewareOptions): RequestHandler; flush(): Promise<void>; close(): Promise<void> }`
  - `createSink(opts: LoggerOptions): { write(entry: LogEntry): void; flush(): Promise<void>; close(): Promise<void> }`

- [ ] **Step 1: Write the failing tests**

```ts
test('level methods stamp level, timestamp and configured dims', async () => {
  const g = await createStubGateway()
  const log = createLogger({ ...base, url: g.url, dims: { company_id: 'acme' } })
  log.info('hello', { dims: { user_id: 'u1' } })
  await log.flush()
  const e = g.batches[0].entries[0]
  expect(e).toMatchObject({ level: 'info', msg: 'hello',
                            dims: { company_id: 'acme', user_id: 'u1' } })
  expect(Date.parse(e.ts)).toBeGreaterThan(0)
})

test('child merges dims and does not mutate the parent', async () => {
  const g = await createStubGateway()
  const log = createLogger({ ...base, url: g.url, dims: { company_id: 'acme' } })
  log.child({ dims: { user_id: 'u1' } }).info('a')
  log.info('b')
  await log.flush()
  const [a, b] = g.batches.flatMap(x => x.entries)
  expect(a.dims).toEqual({ company_id: 'acme', user_id: 'u1' })
  expect(b.dims).toEqual({ company_id: 'acme' })
})

test('never throws into application code when the gateway is unreachable', async () => {
  const log = createLogger({ ...base, url: 'ws://127.0.0.1:1/none',
                             spool: { dir: tmp() }, onError: () => {} })
  expect(() => log.info('still fine')).not.toThrow()
  await log.close()
})

test('coerces an unknown level to info', async () => {
  const g = await createStubGateway()
  const log = createLogger({ ...base, url: g.url })
  ;(log as any).log('verbose', 'x')
  await log.flush()
  expect(g.batches[0].entries[0].level).toBe('info')
})

test('createSink accepts raw entries for a pino or winston adapter', async () => {
  const g = await createStubGateway()
  const sink = createSink({ ...base, url: g.url })
  sink.write({ ts: new Date().toISOString(), level: 'warn', msg: 'from pino' })
  await sink.flush()
  expect(g.batches[0].entries[0]).toMatchObject({ level: 'warn', msg: 'from pino' })
  await sink.close()
})

test('redacts before anything reaches the wire', async () => {
  const g = await createStubGateway()
  const log = createLogger({ ...base, url: g.url })
  log.info('login', { meta: { body: { password: 'hunter2' } } })
  await log.flush()
  expect(JSON.stringify(g.batches)).not.toContain('hunter2')
})
```

`outage.test.ts` — the end-to-end case from the spec:

```ts
test('an outage costs delay, not logs', async () => {
  const dir = tmp()
  const g = await createStubGateway()
  const log = createLogger({ ...base, url: g.url, spool: { dir } })
  log.info('before'); await log.flush()

  await g.stop()                                   // gateway dies mid-stream
  for (let i = 0; i < 50; i++) log.info(`during-${i}`)
  await waitFor(() => new Database(path.join(dir, 'spool.db'))
                       .prepare('select count(*) c from spool').get().c > 0)

  await g.start()                                  // gateway returns
  await waitFor(() => g.batches.flatMap(b => b.entries).length >= 51, 5000)

  const msgs = g.batches.flatMap(b => b.entries).map(e => e.msg)
  expect(new Set(msgs).size).toBe(msgs.length)     // exactly once, no duplicates
  for (let i = 0; i < 50; i++) expect(msgs).toContain(`during-${i}`)
  await waitFor(() => new Database(path.join(dir, 'spool.db'))
                       .prepare('select count(*) c from spool').get().c === 0)
  await log.close()
})

test('redacted secrets never appear in the on-disk spool', async () => {
  const dir = tmp()
  const log = createLogger({ ...base, url: 'ws://127.0.0.1:1/none',
                             spool: { dir }, onError: () => {} })
  log.info('login', { meta: { body: { password: 'hunter2' } } })
  await log.flush()
  expect(fs.readFileSync(path.join(dir, 'spool.db'), 'utf8')).not.toContain('hunter2')
  await log.close()
})

test('close drains undelivered entries to the spool so the next process sends them', async () => {
  const dir = tmp()
  const log = createLogger({ ...base, url: 'ws://127.0.0.1:1/none',
                             spool: { dir }, onError: () => {} })
  log.info('pending'); await log.close()
  const s = createSpool({ dir })
  expect(s.count()).toBeGreaterThan(0)
})

test('mode always writes to the spool before sending', async () => {
  const dir = tmp()
  const g = await createStubGateway({ onBatch: () => {} })   // never acks
  const log = createLogger({ ...base, url: g.url, spool: { dir, mode: 'always' } })
  log.info('durable'); await log.flush()
  expect(createSpool({ dir }).count()).toBe(1)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/client/test/logger.test.ts packages/client/test/outage.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `createLogger`, `createSink` and the package exports**

Wiring: each log call builds a `LogEntry`, applies `redactBody` and `truncateJson` to `meta`, and pushes to the batcher. The batcher's `onBatch` mints a ULID and, in `on-failure` mode, calls `transport.send`; if that returns false, or the state is not `open`, or the batch is later nacked as retryable, the batch goes to the spool. In `always` mode it is spooled first and sent from the spool. A drain loop runs whenever the transport is open and the spool is non-empty, claiming up to the free ack window, and `ack` deletes the row. `droppedSinceLast` carries the batcher's drop count plus the spool's pruned count.

`createLogger` must not reject or throw if the spool is unavailable — it proceeds memory-only and reports once through `onError`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/client`
Expected: PASS, all suites.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src packages/client/test
git commit -m "feat(client): logger wiring with spool replay and drain on shutdown"
```

---

## Task 7: Express middleware

**Files:**
- Create: `packages/client/src/middleware.ts`
- Test: `packages/client/test/middleware.test.ts`

**Interfaces:**
- Consumes: Task 6 `Logger`, Task 2 redaction.
- Produces: `expressMiddleware(opts?: MiddlewareOptions): RequestHandler` where `MiddlewareOptions = { resolveDims?: (req) => Record<string,string|undefined>; ignore?: (req) => boolean; bodies?: 'never'|'on-error'|'sample'|'always'; sampleRate?: number; maxBodyBytes?: number; allowFields?: string[] }`

Emitted entry: `kind: 'request'`, `msg` of `` `${method} ${route} ${status}` ``, level `error` for 5xx, `warn` for 4xx, `info` otherwise, and `meta.http = { method, route, path, status, duration_ms, request_id, req: { headers, body? }, res: { body? } }`.

- [ ] **Step 1: Write the failing tests**

Driven with `supertest` against a small Express app.

```ts
test('logs one line per request with route, status and duration', async () => {
  const { app, entries } = appWith({})
  await request(app).get('/users/1').expect(200)
  expect(entries).toHaveLength(1)
  expect(entries[0]).toMatchObject({ kind: 'request', level: 'info' })
  expect(entries[0].meta.http).toMatchObject({ method: 'GET', route: '/users/:id', status: 200 })
  expect(entries[0].meta.http.duration_ms).toBeGreaterThanOrEqual(0)
})

test('levels follow status: 4xx warn, 5xx error', async () => {
  const { app, entries } = appWith({})
  await request(app).get('/missing'); await request(app).get('/boom')
  expect(entries.map(e => e.level)).toEqual(['warn', 'error'])
})

test('resolveDims attaches dimensions and ignore skips requests', async () => {
  const { app, entries } = appWith({ resolveDims: () => ({ company_id: 'acme' }),
                                     ignore: (r) => r.path === '/health' })
  await request(app).get('/health'); await request(app).get('/users/1')
  expect(entries).toHaveLength(1)
  expect(entries[0].dims).toMatchObject({ company_id: 'acme' })
})

test('on-error captures bodies only for failures', async () => {
  const { app, entries } = appWith({ bodies: 'on-error' })
  await request(app).post('/echo').send({ a: 1 })      // 200
  await request(app).post('/fail').send({ a: 1 })      // 500
  expect(entries[0].meta.http.req.body).toBeUndefined()
  expect(entries[1].meta.http.req.body).toEqual({ a: 1 })
})

test('captured bodies are redacted and truncated', async () => {
  const { app, entries } = appWith({ bodies: 'always', maxBodyBytes: 64 })
  await request(app).post('/fail').send({ password: 'hunter2', pad: 'x'.repeat(500) })
  const body = entries[0].meta.http.req.body
  expect(JSON.stringify(body)).not.toContain('hunter2')
  expect(body).toMatchObject({ _truncated: true })
})

// Review Focus: Node hands over array and numeric header values
test('handles array-valued and numeric headers without crashing', async () => {
  const { app, entries } = appWith({ bodies: 'always' })
  await request(app).post('/echo').set('Content-Type', 'application/json').send({ a: 1 })
  const h = entries[0].meta.http.req.headers
  expect(typeof h['content-length']).toBe('string')
  expect(Object.values(h).every(v => typeof v === 'string')).toBe(true)
})

test('leaves a streaming response unbuffered and unbroken', async () => {
  const { app, entries } = appWith({ bodies: 'always' })
  const res = await request(app).get('/stream').expect(200)
  expect(res.text).toBe('abc')                              // response intact
  expect(entries[0].meta.http.res?.body).toBeUndefined()    // not captured
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/client/test/middleware.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `expressMiddleware`**

Record `process.hrtime.bigint()` at entry and log on the response `finish` event, reading `req.route?.path` for the route. Response capture wraps `res.write` and `res.end` to collect chunks only when the mode calls for it and the content type is JSON-ish; it must skip `text/event-stream`, `multipart/*`, and any non-JSON type, and stop buffering past `maxBodyBytes`. Header values are coerced with `String()`, arrays joined with `', '`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/middleware.ts packages/client/test/middleware.test.ts
git commit -m "feat(client): Express middleware with body capture policies"
```

---

## Task 8: Build, docs, and a runnable example

**Files:**
- Create: `packages/client/tsup.config.ts`, `packages/client/README.md`, `examples/express-app/index.js`, `examples/express-app/package.json`
- Modify: `packages/client/package.json` (exports map, files, build script)
- Test: `packages/client/test/build.test.ts`

**Interfaces:**
- Consumes: Task 6 exports.
- Produces: `dist/index.js` (CJS), `dist/index.mjs` (ESM), `dist/index.d.ts`, resolvable through an `exports` map with `require` and `import` conditions.

- [ ] **Step 1: Write the failing test**

```ts
test('the built package is importable both ways and exposes createLogger', async () => {
  execSync('pnpm --filter @logguber/client build', { stdio: 'inherit' })
  expect(fs.existsSync('packages/client/dist/index.d.ts')).toBe(true)
  const cjs = require(path.resolve('packages/client/dist/index.js'))
  const esm = await import(path.resolve('packages/client/dist/index.mjs'))
  expect(typeof cjs.createLogger).toBe('function')
  expect(typeof esm.createLogger).toBe('function')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/client/test/build.test.ts`
Expected: FAIL — no build output.

- [ ] **Step 3: Configure tsup for dual output and declarations, and write the README**

README covers: install as a workspace dependency, `createLogger` options, the Express middleware, what redaction does by default and how to extend it, body capture modes with their storage implications, and the spool's bounds. State plainly that header capture is allowlist-only and why.

- [ ] **Step 4: Write the example app**

`examples/express-app/index.js`: an Express server with two routes (one success, one failure), `createLogger` pointed at `LOGGUBER_URL`, the middleware installed with a `resolveDims` reading a fake auth header, and `SIGTERM` draining via `log.close()`.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "build(client): dual ESM/CJS output, README and example app"
```

---

## Not in this plan

Deliberately deferred to the next two plans, each of which produces working software on its own:

- **Gateway plan** — Fastify handshake auth (key parsing, IP allowlist, service/env scope pinning), batch validation, SQLite store (keys, options, dedupe ledger, usage rollups at every hierarchy depth), Loki push, live fan-out with the ring buffer, `docker-compose.yml` with Caddy and Loki, and the Loki configuration this spec pins (`max_line_size_truncate`, `reject_old_samples_max_age: 7d`, per-level retention streams).
- **Console plan** — Next.js search, instant live tail over SSE, usage charts from the rollups, and the admin screens for keys, allowlists, dimension hierarchy, and retention.

The client's contract with the gateway is fixed by `packages/shared/src/protocol.ts` from Task 1, so the gateway plan consumes it rather than renegotiating it.
