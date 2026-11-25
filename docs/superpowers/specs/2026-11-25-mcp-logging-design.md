# MCP tool calls as a first-class entry kind — design

**Status:** awaiting approval
**Size:** medium (four packages, one schema migration)

## Intent

An MCP tool call is a request/response exchange with a name, arguments, a
result, a duration and a failure mode. Today the only way to log one is a text
line: `log.info('tool search_issues took 412ms')`. Everything the console does
for HTTP — the duration column, the status colour, the inspector's
request/response tabs, the per-route usage counters, `duration:>500` as a
query — stops at the edge of the MCP world.

This adds `kind: 'mcp'` as a second structured entry kind alongside
`kind: 'request'`, captured by the client, accepted and counted by the
gateway, and rendered in the console's inspector with tabs that fit a tool
call rather than an HTTP exchange.

Two sides produce these entries, and both are in scope:

- **server role** — an MCP server records the calls it *serves*. This is the
  common case: you run a tool, you want to know who called it, with what, how
  long it took and whether it failed.
- **client/agent role** — an agent records the tools it *used*. Same shape,
  opposite direction: now `tool` is somebody else's tool and the duration
  includes their work plus the transport.

They are the same measurement taken from opposite ends, so they are one entry
kind with a `role` field, not two.

## Goals

- `kind: 'mcp'` end to end: client → gateway → Loki → console inspector.
- Capture with no new runtime dependency and no MCP SDK import. A hand-rolled
  server over stdio must be instrumentable with the same call as one built on
  `@modelcontextprotocol/sdk`.
- Tool arguments and results captured through the *existing* redaction and
  size-capping path, never a second one.
- MCP calls counted separately from HTTP requests in `usage_rollup`, on an
  existing database with real history, without losing a row.
- `tool:` as a real server-side query field, and `kind:` so "show me the MCP
  traffic" is one term.
- A readable one-line terminal format, and a terminal that cannot corrupt a
  stdio MCP server's protocol stream.

## Non-goals

- Instrumenting the MCP protocol itself: `initialize`, `tools/list`,
  `resources/read`, prompts, notifications, sampling. Only tool *calls*.
- Transport-level capture (reading JSON-RPC frames off a stdio pipe or an SSE
  stream). That is a different, much more invasive design; see Approaches.
- Streaming / partial tool results. One entry per completed call.
- Linking an agent-side entry to the server-side entry for the same call. That
  needs a propagated id through the MCP envelope, which the protocol has no
  field for today. The `call_id` field leaves room; nothing correlates yet.
- An MCP breakdown in the Usage or Overview screens. The counter column is
  added and populated; nothing reads it yet. Deliberate — see Left out.
- Auto-detecting that a process is a stdio MCP server. Not knowable; handled
  with an explicit option instead.

## Anti-goals

- **Anything that changes what a tool returns, or how it fails.** A throwing
  tool must throw its original error, unchanged, with its original stack. A
  failure inside logging must be invisible to the tool's caller. This is the
  same discipline `middleware.ts` holds and it is non-negotiable.
- Writing a single byte to stdout from a process whose stdout is a protocol
  stream.
- A second `kind` whose validation the gateway accepts loosely. `'mcp'` is
  added to a closed set; everything else is still dropped.

## Constraints

- `kind` is a closed union in `packages/shared/src/protocol.ts`, re-validated
  in `apps/ingest/src/server.ts` (`validate`), and an unknown kind is silently
  dropped there. Both have to change or client entries vanish at the gateway.
- `usage_rollup`'s schema is applied as `CREATE TABLE IF NOT EXISTS`, which
  does nothing to an existing table. `openStore` already carries two ad-hoc
  migrations (rebuild `ingest_batches`, `ALTER TABLE operators ADD COLUMN`),
  so the precedent is in-place `ALTER TABLE` guarded by `PRAGMA table_info`.
  A new column must be added the same way, idempotently.
- `meta` is redacted and truncated once, centrally, in `logger.ts:enqueue`.
  Capture must rely on that pass rather than add its own, exactly as the
  Express middleware does.
- The console's terminal renderer defaults to `process.stdout`. For a stdio
  MCP server that is the protocol stream: one log line and every frame after
  it is malformed JSON-RPC.
- `LogRow` is declared twice (`lib/types.ts`, `lib/server-queries.ts`) and
  built twice (`server-queries.toRow` for stored rows, `LiveConsole.toRow` for
  live ones). All four need the new fields or a field appears in one view and
  not the other.
- `FIELDS.duration` maps to the label `duration_ms`. Naming the MCP duration
  `duration_ms` too is therefore not a coincidence — it is what makes
  `duration:>500` work across both kinds for free.

## Approaches

### How to capture a call

1. **Transport interception** — wrap the stdio/SSE stream and parse JSON-RPC
   frames. Catches everything, including calls that never reach a handler,
   and needs no application change. Rejected: it has to re-implement framing
   per transport, it sees request and response as unrelated frames and must
   correlate them itself, and it is the most dangerous possible place to have
   a bug — a parser in front of the protocol stream.
2. **SDK integration** — a `Server` subclass or a middleware hook from
   `@modelcontextprotocol/sdk`. Rejected: a runtime dependency on an SDK the
   client does not otherwise need, pinned to its API, and useless to a
   hand-rolled server.
3. **A wrapper the application applies to its own handler.** Chosen. It is
   where the duration is actually measurable, it is dependency-free, it works
   for any server whatever its transport, and it mirrors
   `createExpressMiddleware`: a thin measuring shell over `logger.log()`.

### Primitive or wrappers

Both. A wrapper cannot cover every shape — a server that dispatches tools
through its own router, or an agent that already has the timing, needs to
report a call it measured itself. So: one low-level primitive that records an
*already finished* call, and two wrappers that measure and then call it. The
wrappers own no capture logic of their own; everything funnels through the
primitive, so there is one place where redaction, capping and the entry shape
live.

### Where the args/result capture policy comes from

`MiddlewareOptions.bodies` defaults to `'on-error'` for HTTP, because bodies
are large and request volume is high. MCP capture defaults to `'always'`
instead: call volume is orders of magnitude lower, and the arguments *are* the
record — an MCP entry with no arguments answers almost nothing. The same
redaction and the same `maxBodyBytes` cap apply, so the risk is the HTTP one,
not a new one. This divergence is deliberate and documented in the option.

## Design

### Data shape

```jsonc
{
  "kind": "mcp",
  "level": "info",              // "error" when the call failed
  "msg": "mcp search_issues ok",
  "meta": {
    "mcp": {
      "role": "server",         // "server" (we served it) | "client" (we called it)
      "tool": "search_issues",
      "server": "atlas-tools",  // optional: which MCP server
      "call_id": "a1b2c3d4",    // 8 hex, same generator as request_id
      "duration_ms": 412.3,
      "ok": false,
      "args": { "query": "…", "token": "[redacted]" },
      "result": { "content": [ … ] },
      "error": { "name": "TypeError", "message": "…" },
      "timings": { "db": 390 }, // app-reported phases, via logger.time()
      "tags": { "agent": "claude" },
      "flags": ["retry"],
      "note": "rate limited upstream",
      "capture_failed": true    // only if args/result capture threw
    }
  }
}
```

Field-by-field rationale:

- **`duration_ms`** — same name as `meta.http.duration_ms` on purpose, so
  `duration:>500` and the console's duration column work unchanged.
- **`ok`, not `status`** — `FIELDS.status` is numeric and compiles to a LogQL
  numeric comparison. An MCP entry promoting a *string* `status` into the same
  structured-metadata key would make `status:>=500` compare against `"error"`.
  A separate boolean avoids the collision entirely.
- **`ok` is false for three different failures**: the handler threw, the
  handler returned `{ isError: true }` (the MCP convention for an in-band tool
  error), or the agent's outbound call rejected. All three are the same fact
  to an operator: the call did not do its job.
- **`args` / `result`, not `req` / `res`** — these are not HTTP bodies and the
  inspector should not pretend they are.
- **`error` is `{ name, message }` only.** A stack is the host application's
  internal detail and is often large; `safeStringify` already reduces an Error
  to exactly these two fields.
- **`timings`** reuses the existing `phases.ts` mechanism verbatim. A tool
  handler wrapped by `wrapMcpTool` runs inside `runWithPhases`, so
  `logger.time('db', fn)` called anywhere beneath it lands in
  `meta.mcp.timings` with no extra API. The inspector's waterfall renderer is
  reused as-is.
- **`tags` / `flags` / `note`** mirror the reserved keys `meta.http` already
  gives applications, so the console line can carry the same short labels.

### Client API

Three additions to `Logger`:

```ts
/** The primitive: record one call that has already finished. */
mcpCall(call: McpCall): void

/** Server role: wrap a tool handler. Same signature in, same signature out. */
wrapMcpTool<A extends unknown[], R>(
  tool: string,
  handler: (...args: A) => R,
  opts?: McpToolOptions,
): (...args: A) => R

/** Client role: wrap an outbound tool call. */
wrapMcpClient<A extends unknown[], R>(
  call: (...args: A) => R,
  opts?: McpClientOptions<A>,
): (...args: A) => R
```

```ts
interface McpCall {
  tool: string
  role?: 'server' | 'client'   // default 'server'
  server?: string
  args?: unknown
  result?: unknown
  error?: unknown              // thrown value; anything, not just Error
  durationMs?: number
  callId?: string
  ok?: boolean                 // inferred from error/result when omitted
  note?: string
  tags?: Record<string, unknown>
  flags?: string[]
  dims?: Record<string, string>
  timings?: Record<string, number>
  capture?: McpCapture         // 'never' | 'on-error' | 'always' (default)
  maxBodyBytes?: number        // default 8192, as HTTP bodies
  allowFields?: string[]
}
```

`wrapMcpTool` and `wrapMcpClient` take the same options minus the per-call
facts, plus hooks evaluated per call (`resolveDims`, `resolveMeta`, `ignore`,
`note`, `tool` for the client wrapper).

Both wrappers:

1. Return a function with the wrapped function's own signature. A sync handler
   stays sync; a promise stays the *same* promise object where possible.
2. Resolve the tool name. For `wrapMcpTool` it is given. For `wrapMcpClient`
   it comes from `opts.tool(...args)`, else from the first argument's `name`
   or `tool` property — which covers `callTool({ name, arguments })`, the
   shape every MCP client uses.
3. Capture arguments from `opts.args(...args)` if given, else the first
   argument's `arguments`/`args` property if it has one, else the first
   argument.
4. Measure with `process.hrtime.bigint()`, exactly as the middleware does.
5. On settle, call `mcpCall`. **Then return or rethrow what the wrapped
   function produced, untouched.**

Every foreign call — the handler's result inspection, the option callbacks,
the `then` of a non-native thenable, the logging itself — is individually
guarded. The one call that is *not* guarded is the wrapped function itself:
its error is the application's and must propagate.

Usage, server side:

```ts
const log = createLogger({ …, console: { enabled: true, output: 'stderr' } })

server.setRequestHandler(CallToolRequestSchema, log.wrapMcpTool(
  'search_issues',
  async (req) => doSearch(req.params.arguments),
  { server: 'atlas-tools', resolveDims: (req) => ({ user_id: req.params._meta?.user }) },
))
```

and agent side:

```ts
const callTool = log.wrapMcpClient(client.callTool.bind(client), { server: 'atlas-tools' })
await callTool({ name: 'search_issues', arguments: { query: 'disk full' } })
```

### `kind` stays `log()`-only

`LogOptions.kind` widens to `'request' | 'mcp'`, and the level methods keep
dropping it, as they do today. `mcpCall` reaches `log()` internally, so an
application never has to forge a kind — and the property that
`log.info({ kind: 'mcp' })` cannot produce one is preserved.

### Terminal line

A new `mcpLine()` beside `requestLine()`, dispatched on `entry.kind`. Same
column grid as a request line so a mixed log still scans vertically:

```
14:22:07      412ms TOOL    [a1b2c3d4] search_issues @atlas-tools user:u_9 — ok
14:22:09       18ms CALL    [77f1aa02] get_cash — error: upstream 503
```

`TOOL` for the server role, `CALL` for the client role, in the column where a
request line prints its method. The tool name sits where the path does, the
server (if any) after it as `@name`, then tags/flags/dims exactly as a request
line renders them, then `ok` or `error: <message>`. Coloured green/red by
`ok`, reusing the status colours.

### stdout is a protocol stream

`ConsoleConfig` gains `output?: 'stdout' | 'stderr'`, default `'stdout'` (no
behaviour change for existing users). For any process whose stdout carries the
MCP protocol — every stdio MCP server — `'stderr'` is the only safe value, and
the option's doc comment, the `Logger.wrapMcpTool` doc comment and the README
all say so.

Not auto-detected: a process cannot tell whether its stdout is a JSON-RPC pipe
or a terminal, and guessing wrong in either direction is worse than an
explicit option. TTY detection, colour and the in-flight block all follow the
chosen stream rather than `process.stdout`.

### Gateway

- `validate()` accepts `kind: 'mcp'` through a shared `KINDS` set exported
  from `@logguber/shared`, so the client union and the gateway's check cannot
  drift. Any other value is still dropped.
- `loki.ts` promotes `tool`, `role`, `call_id`, `duration_ms` and `ok` out of
  `meta.mcp` into structured metadata, the mirror of what
  `METADATA_FROM_META` does for `meta.http`. This is what makes `tool:` a
  server-side filter rather than a free-text match. `kind` is already
  promoted, so `kind:mcp` needs nothing new in Loki.
- `rollup.ts` counts `mcp_calls` as a fourth counter beside `lines`, `bytes`,
  `requests`, `errors`. An MCP entry increments `mcp_calls` and `lines`, never
  `requests`.

### SQLite migration

`usage_rollup` gains `mcp_calls INTEGER NOT NULL DEFAULT 0`.

`openStore` already does this kind of thing twice by hand. Rather than a third
copy, those become one helper:

```ts
function addColumn(db, table, column, definition): void
```

which reads `PRAGMA table_info(<table>)`, returns if the column is already
there, and otherwise runs `ALTER TABLE … ADD COLUMN`. Idempotent by
construction, so it is safe on every start; safe to run repeatedly; and
`ALTER TABLE … ADD COLUMN` with a `NOT NULL DEFAULT 0` rewrites no rows —
existing history keeps every `lines`, `bytes`, `requests` and `errors` value
it had and reads `mcp_calls = 0` for hours recorded before the upgrade, which
is the truth.

The existing `operators.must_change_password` migration is rewritten to call
the helper; the `ingest_batches` rebuild stays as it is (it drops a table, not
a column).

### Console

`LogRow` gains `kind?`, `tool?`, `mcpRole?`, `callId?` and `ok?`; `duration`
is reused. Both `toRow` implementations fill them, from
`meta.mcp`/structured metadata on the stored side and from the live entry on
the other. `LiveConsole.toRow` also starts carrying `kind` into `payload`, so
a live row's Raw JSON and a stored row's Raw JSON agree, and `kind:mcp`
filters the live view too.

`RequestInspector` picks its tab set from `row.kind`:

| kind | tabs |
| --- | --- |
| `request` (and anything else) | Overview, Request, Response, Headers, Timing, Trace, Exception, Raw JSON |
| `mcp` | Overview, Arguments, Result, Timing, Error, Raw JSON |

An MCP Overview shows tool, role, server, call id, duration and outcome in
place of method/route/status. The Timing tab is reused unchanged — it reads
`timings` and a total, both of which an MCP entry has. No HTTP tab is rendered
for an MCP entry, so there are no permanently empty panes.

### Query language

Two fields added to `FIELDS`:

- `tool` → label `tool`, matching the promoted metadata key.
- `kind` → label `kind`, so `kind:mcp` and `kind:request` work.

`fieldValue()` (the client-side matcher for the live stream) gains two
fallbacks: `meta.mcp[label]`, and the entry's top-level `meta.kind` for the
`kind` field. `compile()` needs no change — both are ordinary non-numeric meta
fields and compile to a label filter like `status` and `method` already do.

`suggest()` offers `mcp`/`request` as values for `kind:`.

## Left out, deliberately

- **No MCP breakdown in the Usage/Overview screens.** The counter is recorded
  so the data exists from the first upgraded deployment onwards; wiring it
  into charts is a separate, UI-shaped change, and shipping a chart of a
  column that is zero for all existing history would read as a bug.
- **No `role:` or `server:` query field.** `tool:` and `kind:` cover the
  questions actually asked; free text still matches the rest. Adding more
  closed-set fields later is additive.
- **No in-flight block for MCP calls.** `pending` is request-shaped
  (method/url) and a long-running tool call is better served by the finished
  line. No API is exposed for it.
- **No `instrumentMcpServer(server)`.** It would need to know an SDK's shape,
  which is the dependency this design refuses.

## Tests that must exist

Client (`packages/client/test/mcp.test.ts`):

- One `kind: 'mcp'` entry per call, with tool, role, duration and `ok`.
- A throwing handler: the original error reaches the caller **by identity**,
  and the entry is `level: 'error'` with `ok: false` and the error recorded.
- A handler returning `{ isError: true }` is `ok: false`, and the result
  object the caller receives is the identical object.
- A sync handler stays sync (the wrapper's return value is not a promise).
- Secrets in arguments and in results are `[redacted]`.
- An oversized argument object is replaced by the truncation marker.
- `capture: 'never'` records duration and tool but no args or result.
- A logger whose `accept` throws does not break the call.
- Option callbacks that throw (`resolveDims`, `ignore`, `tool`, `note`) cost
  their field, not the call.
- `logger.time()` inside a wrapped tool lands in `meta.mcp.timings`.
- The client wrapper reads the tool name from `{ name }`.
- `log.info({ kind: 'mcp' })` does not produce an MCP entry.

Console (`packages/client/test/console.test.ts` additions):

- An MCP entry renders the one-line format, server and client roles.
- A failed call renders `error: <message>`.
- `output: 'stderr'` writes to stderr and nothing to stdout.

Gateway (`apps/ingest/test/mcp.test.ts`):

- `kind: 'mcp'` survives `validate`; `kind: 'tool'` is dropped to no kind.
- `tool`, `role`, `call_id`, `duration_ms`, `ok` reach structured metadata.
- An MCP entry increments `mcp_calls` and `lines`, not `requests`; an HTTP
  one the reverse.
- `addColumn` on a database created without `mcp_calls` adds it, preserves
  every existing row's counters, and is a no-op the second time.

Shared (`packages/shared/test/`):

- `tool:` and `kind:` parse, compile to a label filter, and match a live
  candidate through `meta.mcp`.

## Process note

Design doc, committed, before any code. Then test-first per area, in the
order shared → client → gateway → console, each a commit of its own.
