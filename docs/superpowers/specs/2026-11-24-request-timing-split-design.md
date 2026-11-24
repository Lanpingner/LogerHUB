# Request timing: server/transit split, plus app-reported phases — design

**Status:** awaiting approval
**Size:** small project (two related parts)

## Intent

A request line carries one duration today, and it answers the wrong question.
`duration_ms` runs from middleware entry to `res.finish`, so a handler that
returns in 4ms but streams 2MB to a phone on a slow link is indistinguishable
from a handler that spent 900ms in a database query. Both read `+904ms`.

Two things are being added, and they answer different questions:

**Part 1 — the server/transit split.** Measured automatically, no app changes.
- **server** — middleware entry until the response's first byte leaves. The
  handler's own work.
- **transit** — first byte until `res.finish`. Pushing the body out: response
  size, client link speed, backpressure.

**Part 2 — phases the app reports itself.** `auth`, `db`, `external`,
whatever the application names. These live *inside* server time and say where
it went. The console already has a waterfall renderer for them and currently
tells you "No phase breakdown was sent with this request"; this gives the
client a way to send it.

Why now: the operator asked for the split to tell "my server is slow" from
"the network is slow", then asked that apps be able to send their own phases
so the breakdown is actionable rather than just a verdict.

## Goals

- Both split numbers on the terminal line the client prints locally, and in
  the console, with no app code changes.
- A phase recorded from anywhere in the call stack — a repository module three
  calls deep — without threading `req` through every signature.
- `duration_ms` keeps its current meaning, so every existing consumer
  (percentile charts, the `duration:` filter, the grid column) is unaffected.

## Non-goals

- Time before Express saw the request (nginx queueing). Considered and set
  aside; see Approaches. The field naming leaves room to add it later.
- Splitting the aggregate percentile charts (Overview, Intelligence). They
  stay on the total.
- New `server:` / `transit:` search filters in the query editor.
- Phase timing for anything that is not an HTTP request (queue consumers,
  cron). The API must not throw there, but it records nothing.

## Anti-goals

- Any measurement that costs the request. Timing capture that can throw on a
  hot path is worse than no timing.
- Inventing a number when the real one is unknown. An aborted request has no
  first byte and must show no split, not a plausible-looking zero.
- A waterfall that double-counts. See the Constraint below — this one drove
  the data shape.

## Constraints

- **The inspector renders `meta.http.timings` as one flat proportional
  waterfall**, normalising by the sum of its values. So `server` and `transit`
  must NOT live in that map alongside `db` and `auth`: `db` is inside
  `server`, and four flat segments would be arithmetically wrong. Confirmed by
  reading `RequestInspector.tsx`.
- The terminal line format was deliberately pinned to match the operator's
  original logger character for character, and two tests assert it
  (`line-format.test.ts`). Widening the duration column breaks that parity.
- `res.writeHead` is often never called explicitly — Express flushes headers
  on the first `write()` or `end()`. The hook must cover all three.
- Phases are **self-reported totals, not a partition of server time.** Two
  concurrent queries under `Promise.all` each report their full duration, so
  phases can sum to more than wall-clock server time. The waterfall normalises
  by sum, so it still renders correctly as proportions; the documentation must
  say what it is showing.
- `dims` are capped at 16 keys and 256 bytes per value elsewhere in the
  client; phase names follow the same ceiling for the same reason.

## Approaches

### Part 1 — where to split

**A. At the first byte, in-process.** Patch `writeHead`/`write`/`end`, record
`process.hrtime.bigint()` on whichever fires first. No configuration, no clock
assumptions, works for every consumer including ones with no proxy in front.
Cannot see time spent queued before Express.

**B. Before the app.** nginx stamps `X-Request-Start: t=$msec`; the middleware
diffs it against entry. Shows request queueing, which is what you want when
the app is saturated. Requires an nginx config change per deployment, silently
produces nothing when absent, and depends on nginx and the app sharing a clock
— true on this host today, a trap once the app moves.

**C. Ingest nginx's own access log.** The only way to measure delivery to the
real client rather than to the kernel socket buffer. A separate feature: new
log source, parser, correlation key.

**Chosen: A** (operator's pick). It answers "how long did the server take to
process", needs nothing installed, and degrades to today's behaviour when the
first byte cannot be observed. B stays additive later.

### Part 2 — how an app records a phase

**D. Automatic context.** `AsyncLocalStorage` (Node built-in) holds a
per-request phase map that the middleware enters. `logger.time('db', fn)`
works anywhere in the call stack.

**E. Explicit request object.** `logger.time(req, 'db', fn)`. Nothing
implicit, trivially debuggable, but every helper that wants to time itself
needs `req` threaded down to it — which in practice means changing signatures
across the codebase, so most code never gets timed.

**F. Nothing new.** `resolveMeta` can already return
`{ timings: { db: 40 } }`, which merges into `meta.http`. Possible today, but
the app hand-rolls every timer and stashes them on `req` itself.

**Chosen: D** (operator's pick). E's cost falls on exactly the deep code most
worth measuring. F stays valid and documented for anyone who wants it.

## Design

### Data shape

Three measured scalars in `meta.http`, beside the existing `duration_ms`:

```json
{
  "duration_ms": 55.5,
  "server_ms": 52.4,
  "transit_ms": 3.1,
  "timings": { "auth": 4.0, "db": 44.2, "render": 3.9 }
}
```

`server_ms` / `transit_ms` are the measured split. `timings` stays what it is
today — app-reported phases within server time — so the existing waterfall
keeps rendering correctly and keeps its current meaning.

Measured values win over app-reported ones: the middleware already merges
`resolveMeta` output with `if (!Object.hasOwn(http, k))`, so an app returning
`server_ms` cannot overwrite the measurement. `server` and `transit` are
additionally refused as phase names.

### Part 1 — measurement

In `packages/client/src/middleware.ts`. Capture `firstByteAt` on the earliest
of `writeHead`, `write`, `end`:

```
server_ms   = firstByteAt - start      // omitted if no first byte
transit_ms  = finishAt - firstByteAt   // omitted if no first byte
duration_ms = finishAt - start         // unchanged
```

A request aborted before any write omits both and keeps the total; the
existing `aborted` flag already marks that case.

### Part 2 — the phase API

New on the logger:

```js
await logger.time('db', () => db.query(sql, args))   // wraps sync or async
const done = logger.phase('external'); …; done()     // manual, for awkward code
```

Backed by one `AsyncLocalStorage` entered once per request by the middleware.
Rules:

- Repeated names **sum**: three queries under `db` produce one `db` total.
  (Per-phase call counts are out of scope — `timings` values must stay plain
  numbers for the existing renderer.)
- Outside a request context, `time()` runs the function and records nothing.
  It never throws for that reason.
- If the wrapped function throws, the phase is still recorded, then the error
  rethrows. Time spent failing is time spent.
- At most 16 distinct phase names per request; further names are dropped
  rather than growing the map.
- Nested and concurrent phases are both allowed and both recorded. They
  overlap, which is why phases are documented as self-reported totals.

### Terminal line

`12ms+3ms` in place of `+15ms`:

```
19:21:04   12ms+3ms GET    [APR] [a1b2c3d4] /users/1 — 200
```

This widens the duration column and so breaks character-for-character parity
with the original logger. It is therefore an option, not a silent change:

```js
console: { timing: 'split' }   // default
console: { timing: 'total' }   // the exact original format
```

**My call, and the one thing here worth arguing with:** `split` as the
default, because a feature nobody enables does not answer the question, and
the parity is recoverable with one word. Non-request lines are untouched
either way. Phases do not appear on the terminal line — three numbers plus a
breakdown is more than a single line can carry; the console is where the
breakdown is read.

### Console

One small change to `RequestInspector.tsx`: show `Server` and `Transit`
alongside the existing `Total` field. The phase waterfall below it needs no
change and starts working as soon as an app sends phases.

## Left to the builder

- Whether `firstByteAt` is captured by extending the existing
  `captureResponse` wrapper or by a second, smaller patch beside it.
- Exact padding width of the split duration column, as long as it is fixed and
  the tests assert it.
- Whether `transit_ms` is suppressed when it rounds to 0ms or always shown.

## Tests that must exist

- Handler that waits, then responds: `server_ms` large, `transit_ms` small.
- Large body against a slow consumer: `server_ms` small, `transit_ms` large.
- Request aborted before any write: no `server_ms`/`transit_ms`,
  `aborted: true`, total still present.
- `server_ms + transit_ms` within tolerance of `duration_ms`.
- `timing: 'total'` reproduces the pinned original line byte for byte.
- `logger.time` three times under one name sums into a single phase.
- `logger.time` called outside a request runs the function and throws nothing.
- A throwing function still records its phase and rethrows.
- An app's `resolveMeta` returning `server_ms` does not overwrite the
  measurement.
- Phase name ceiling: the 17th distinct name is dropped, the first 16 survive.

## Process note

The design doc for a project normally gets a fresh-eyes builder review before
it reaches you. This session is configured not to spawn subagents, so I read
it as that builder myself. That found the double-counting problem above, which
changed the data shape — worth knowing that the check was self-administered
rather than independent.
