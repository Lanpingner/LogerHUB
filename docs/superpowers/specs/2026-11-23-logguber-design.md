# Logguber — Design

Date: 2026-11-23
Status: awaiting approval

## 1. Intent and why

Logguber is a self-hosted log and API-usage console for a single operator who runs
several Express/Node API services. It has two jobs:

1. **Find things in logs.** Search and live-tail the logs coming out of every service,
   without SSHing into boxes or paging through files.
2. **Show who uses what.** Answer "how much is each client company using my APIs, and
   which of their users or API keys is doing it" — broken down over time.

The operator is the only person who logs into the console. The "companies" in the data
are clients of the operator's APIs; they are not users of this system and have no
accounts in it. That distinction shapes everything: there is no per-customer login,
no customer-facing isolation guarantee, and no tenant billing.

Logs are produced by Express servers, so a Node module that an Express app installs and
calls is part of the product, not an afterthought. Ingest must be trivial to adopt.

## 2. Goals

- Search logs across all services with filters on service, level, time, free text, and
  any custom dimension (company, user, API key, …).
- Live tail that is **instant**: a line appears in the console the moment the gateway
  accepts it, not after a storage round trip.
- First-class handling of API logs: JSON payloads including request/response headers and
  bodies, with secrets redacted before they ever leave the application process.
- Usage charts: request counts and log volume over time, grouped by any configured
  dimension, drillable from service → company → user (and deeper if configured later).
- A configurable, ordered hierarchy of dimensions that drives drill-down and grouping,
  changeable without data migration or re-ingest.
- A Node client module providing a logger, an Express request-logging middleware, a
  persistent WebSocket stream to the gateway, and a local SQLite spool that holds logs
  while the server is unreachable and replays them on reconnect — all non-blocking from
  the application's point of view.
- Credential-scoped writes: each service gets its own API key, and a key may only write
  logs under the services it is scoped to.
- IP allowlisting on the ingest path.
- Single-command local/VPS deploy via docker-compose.

## 3. Non-goals

- Per-client or per-company login to the console. One operator account (plus optional
  extra operator accounts later).
- Alerting, paging, or notification rules.
- Metrics or distributed tracing. Logs and log-derived counts only.
- Running Grafana. The Next.js console replaces it.
- Horizontal scale-out of Loki (microservices mode), multi-region, or HA.
- Billing or invoicing from usage data. The console reports usage; money is elsewhere.
- A public SaaS offering of this system.
- Publishing `@logguber/client` to a registry. It is consumed as a local workspace
  dependency for now; packaging stays publish-ready so npm is a later decision, not a
  rewrite.
- Drop-in transports for pino or winston in the first version (see section 10).

## 4. Anti-goals

Things that would make this a failure even if every feature works:

- **Logging slows down or breaks the host application.** A log call must never block a
  response, throw into application code, or grow memory without bound when the log
  server is unreachable.
- **Logs are silently lost.** With a local spool in the client, an unreachable server must
  cost nothing but delay. Loss is acceptable only when the spool's own bounds are hit, and
  never without the operator being able to see the count.
- **The client fills the host's disk.** A spool that grows without limit takes down the
  very application it was meant to observe. Bounded size and age are not optional.
- **The log store becomes a credential store.** API logs carry `Authorization` headers,
  cookies, and bodies containing passwords and tokens. If those are logged verbatim, one
  console breach hands over every client's credentials, and the logs become a liability
  with a retention period. Redaction must be the default and must happen before anything
  leaves the application process.
- **Live tail that is not live.** A tail that lags several seconds behind reality is not
  what was asked for and will not be trusted for debugging.
- **Label cardinality explosion.** Putting company or user IDs into Loki stream labels
  would degrade Loki as the client list grows. The design must make this hard to do by
  accident.
- **Usage dashboards that take 30 seconds to load.** If answering "usage per company
  last 30 days" requires scanning a month of raw logs on every page view, the feature is
  unusable and will not be used.

## 5. Constraints

- Grafana Loki 3.7.x as the log store (decided by the operator). Single-binary mode,
  TSDB index, v13 schema, structured metadata enabled.
- Loki hard limits: 128 structured-metadata entries and 64KB of structured metadata per
  log line; lines exceeding either are rejected by the distributor with HTTP 400. Loki's
  default index-label limit is 15, and fewer is better.
- Loki has no authentication or authorization of its own. All access control must live in
  front of it, and Loki must never be reachable from outside the deployment's internal
  network.
- Node.js 22+, TypeScript, Next.js (App Router) for the console.
- Ingest is a persistent WebSocket stream, and the client spools to local SQLite whenever
  the server is unreachable (both operator decisions).
- All server-side state — keys, allowlists, options, usage counters — lives in SQLite, not
  Postgres (operator decision). SQLite allows one writer at a time, which bounds ingest
  write throughput and rules out putting the file on NFS.
- Loki rejects samples older than `reject_old_samples_max_age`, which bounds how long an
  outage can last before spooled logs become unreplayable. Set to 7 days, matching the
  client's spool age limit.
- Loki's `max_line_size` defaults to 256KB, and Grafana advises against raising it. Worse,
  with `max_line_size_truncate` off (the default) an oversized line is **discarded** with a
  400 rather than cut short. Request and response bodies can easily exceed this, so line
  size has to be managed by the client rather than discovered at the server.
- Loki's own tail endpoint streams from ingesters with a built-in delay, so it cannot
  satisfy "instant". Instant delivery has to come from the gateway, which already holds
  the line in memory.
- Self-hosted via docker-compose. No managed cloud services assumed.
- Volume assumption: under roughly one million log lines per day across all services.
  Design holds comfortably at that scale; above ~10M/day the storage choice should be
  revisited.
- Single operator means operational simplicity outranks scalability everywhere the two
  conflict.

## 6. Approaches considered

**A. One Next.js app does everything.** Ingest arrives at a Next.js route handler that
authenticates and forwards to Loki; the same app serves the console.
*Trade-off:* simplest deploy, but the ingest path shares a process with the UI. UI
deploys drop in-flight pushes, dashboard queries compete with ingest, and Next.js route
handlers are a poor fit for sustained high-rate POSTs.

**B. Separate ingest gateway plus a read-only Next.js console.** A small Fastify service
owns ingest: API-key auth, IP allowlist, write scoping, batching into Loki. Next.js
queries Loki and the SQLite store server-side and renders the console. One repo, two apps,
shared types, one docker-compose.
*Trade-off:* two processes instead of one. In exchange, ingest survives UI redeploys, the
two sides scale independently, and all security-critical code sits in one small
auditable service.

**C. Agent-based.** Apps write JSON to stdout; Grafana Alloy on each host tails it and
pushes to Loki behind nginx doing auth and IP allowlisting.
*Trade-off:* no custom ingest code and disk-buffered durability, but an agent to install
on every host, awkward per-key write rules expressed in nginx config, and it abandons the
npm-module developer experience that was an explicit requirement.

**Chosen: B**, selected by the operator. It preserves the required Node-module ingest
experience, concentrates the auth logic in one testable place, and decouples the
data-loss-sensitive path from the dashboard.

ClickHouse was considered as a Loki replacement — it would be stronger at per-client usage
aggregation — but Loki was specified by the operator and is sufficient for log search and
tail at the stated volume. Settled, not open.

## 7. Architecture

```
Express app ──┐
Express app ──┼── @logguber/client ──WSS (acked stream)──────> ingest gateway (Fastify)
Express app ──┘      └─ SQLite spool (while unreachable)        │        │
                                                                │        └─> SQLite
                                                                │             (options, api keys,
                                                                ▼              usage rollups)
                                                              Loki                  ▲
                                                                ▲                   │
                                        Next.js console ────────┴───────────────────┘
                                        (server-side reads only)
```

Four components in one pnpm monorepo:

| Package | What it is |
|---|---|
| `packages/client` | The npm module Express apps install. Streams over WebSocket, spools to SQLite when offline. |
| `apps/ingest` | Fastify ingest gateway. The only thing that writes to Loki. |
| `apps/web` | Next.js console. Read-only with respect to logs. |
| `packages/shared` | Shared TypeScript types, dimension-config schema, LogQL builder. |

Plus `docker-compose.yml` running Caddy, Loki, ingest, and web — no database container,
since SQLite is a file on a shared volume. Caddy is the only service with published ports;
it terminates TLS (automatic certificates) and forwards to the gateway and the console,
including WebSocket upgrades. Loki is bound to the internal network only, so nothing but
the gateway and the console can reach it. The gateway therefore sees exactly one proxy
hop; `TRUSTED_PROXY_HOPS` defaults to 1 and is configurable for operators who front it
with Cloudflare or their own nginx.

### Why there is a SQL store next to Loki, and why it is SQLite

This revises an earlier assumption that Loki alone could serve both jobs. Loki can filter
and group by structured metadata, but it does so by scanning log lines — there is no index
on company or user. A 30-day usage chart would scan 30 days of logs on every page load,
which collides with the anti-goal above.

Instead, the gateway already parses every line on its way through, so it increments usage
counters at ingest time for nearly free. Usage charts then come from small, indexed SQL
aggregates and load instantly, while Loki serves raw search and tail — each store doing
what it is good at. The same store holds every option the system has: API keys and their
scopes, IP allowlists, the dimension hierarchy, display names, retention settings, and the
operator account.

That store is **SQLite**, a single file on a volume shared by the gateway and the console
(operator's decision, and the right one at this scale):

- No database container, no connection strings, no separate backup procedure — backing up
  is copying one file, and the whole deployment is Caddy, Loki, and two Node processes.
- Reads are in-process and effectively free, which is what the console does almost
  exclusively.
- "Database unreachable" stops being a failure mode at all, since there is no network
  between a process and its data.

What it costs, stated plainly:

- **One writer at a time.** SQLite in WAL mode allows concurrent readers but serialises
  writers. Only the gateway writes on the hot path, and it coalesces a whole batch into a
  handful of statements, so at the stated volume this is comfortable. It is, however, the
  component that would need replacing first if ingest volume grew by an order of
  magnitude — and because all access sits behind a small data-access module, swapping in
  Postgres later is a contained change rather than a rewrite.
- **Both processes must share a filesystem.** The gateway and the console cannot be split
  across machines without moving to a client/server database. Single-host compose is the
  assumed deployment, so this is not a present constraint, just a future ceiling.
- **No network types or `LISTEN`/`NOTIFY`.** CIDR matching happens in application code,
  and key-revocation signalling uses an internal HTTP call plus a version poll instead of
  database notifications (section 9).

## 8. Data model

### Loki labels (indexed, must stay low-cardinality)

Exactly three:

- `service` — `office-api`, `public-api`, `chat-api`, `chat-ws`, … (single digits of values)
- `env` — `prod`, `staging`, …
- `level` — `debug`, `info`, `warn`, `error`, `fatal`

Nothing else is ever promoted to a label. The gateway enforces this: it builds label sets
itself from a fixed allowlist and ignores any attempt by a client to add labels. This is
how the cardinality anti-goal is made structurally impossible rather than merely
documented.

### The log line is JSON

Most traffic is API logs: method, path, status, timing, headers, and body fragments. So
the Loki line itself is a compact JSON object, not a prose string:

```json
{ "msg": "GET /v1/users 200",
  "http": { "method": "GET", "route": "/v1/users", "status": 200, "duration_ms": 42,
            "req": { "headers": { "content-type": "application/json" },
                     "body": { "filter": "active" } },
            "res": { "body": { "count": 17 } } } }
```

This is the shape Loki expects for structured logs: arbitrary nesting and per-request
shapes are fine, and queries reach into any depth with `| json | http_status=500`. The
alternative — flattening everything into structured metadata — collapses under Loki's
128-entry limit and cannot represent a nested body at all.

So the split is:

- **Nested payloads, headers, bodies** → the JSON line body. Unindexed, scanned at query
  time, which is fine once labels and structured metadata have narrowed the candidate set.
- **The handful of fields used for filtering, grouping, and drill-down** → structured
  metadata, duplicated out of the JSON (below).

**Line size is the client's job.** Because Loki drops rather than truncates oversized
lines by default, the client caps serialised body size (default 8KB per body) and replaces
anything larger with `{"_truncated": true, "_bytes": 41233}`. Server-side,
`max_line_size_truncate` is enabled with an identifier marker as a second line of defence,
accepting that server-truncated JSON will not parse — which is exactly why the client
truncates first, at a structural boundary, where it still can.

### Structured metadata (per line, not indexed, filterable)

Every custom dimension lives here: `company_id`, `user_id`, `api_key_id`, and anything
else the operator invents later. Also per-request fields from the Express middleware:
`method`, `path`, `route`, `status`, `duration_ms`, `request_id`, `ip`.

The gateway enforces Loki's limits before pushing — at most 128 entries and 64KB per line
— rejecting or truncating with a clear error rather than letting Loki 400 the whole batch.

### Configurable dimension hierarchy

Stored in SQLite as a settings row, editable from the console — not a file requiring a
redeploy:

```json
{ "levels": [
    { "key": "service",    "label": "Service" },
    { "key": "company_id", "label": "Company" },
    { "key": "user_id",    "label": "User" } ] }
```

This ordered list drives the drill-down tree, the breadcrumbs, and the default group-by on
usage charts. Adding a level is one entry; reordering is a drag. Nothing in storage
changes, and historical lines simply show `unknown` for a dimension they never carried.
`service` is special only in that it is also a Loki label; every other level resolves
against structured metadata and the usage rollup.

### SQLite schema (outline)

Arrays and structured values are stored as JSON text, since SQLite has no array, `jsonb`,
or `cidr` types; `json_each` covers the few queries that need to look inside them, and
scope checks happen in application code anyway.

- `api_keys` — `id`, `name`, `key_id` (public prefix, unique, indexed), `secret_hash`,
  `service_scope` (JSON array), `env_scope` (JSON array, null meaning any),
  `ip_allowlist` (JSON array of CIDR strings), `disabled_at`, `created_at`,
  `last_used_at`, `last_used_ip`.
- `usage_rollup` — `hour` (epoch seconds), `depth` (integer), `dims` (canonical JSON
  text), `lines`, `bytes`, `requests`, `errors`. Unique on `(hour, depth, dims)`.
- `ingest_batches` — `batch_id`, `key_id`, `received_at`. Dedupe ledger for retries,
  pruned after 24 hours.
- `dimension_labels` — `dim_key`, `dim_value`, `display_name`. Optional human-readable
  names for IDs; purely cosmetic.
- `settings` — single row of JSON; holds the dimension hierarchy, retention preference,
  global IP allowlist, and every other system option, plus a `config_version` the gateway
  polls to notice changes.
- `operators` — `id`, `email`, `password_hash` (argon2id), `created_at`.
- `ingest_errors` — recent rejected batches with reason, so silent loss is visible.

#### Rollup grain: one row per hierarchy prefix

A single row per full dimension combination would force every top-level chart to sum
across all of its children with jsonb predicates — the slow-dashboard anti-goal moved from
Loki into SQL. Instead the gateway writes one row per *prefix* of the configured
hierarchy. With levels `[service, company_id, user_id]`, one line produces three upserts:

| depth | dims |
|---|---|
| 1 | `{"service":"public-api"}` |
| 2 | `{"service":"public-api","company_id":"acme"}` |
| 3 | `{"service":"public-api","company_id":"acme","user_id":"u_123"}` |

Each drill-down level then reads rows at exactly its own depth with no aggregation across
children, so every usage query is an indexed range scan. Write amplification is bounded by
the number of configured levels (three or four), and upserts are coalesced per batch
before hitting SQLite, so a 100-line batch is a handful of statements rather than
hundreds — which also keeps SQLite's single-writer lock held briefly.

`dims` is normalised before hashing into the unique key: keys sorted, absent dimensions
written explicitly as `"unknown"` rather than omitted or null. Without this the unique
constraint silently splits what should be one row.

Adding a level later starts producing rows at the new depth from that moment; older depths
remain valid and queryable, which is why the hierarchy stays cheap to change.

#### What counts as a request, and as an error

- `lines` and `bytes` count every ingested entry.
- `requests` counts entries the client marks `kind: "request"`. Only the Express
  middleware sets this, so an ordinary `log.info` never inflates request counts.
- `errors` counts entries at level `error` or `fatal`. The middleware already emits 5xx
  responses at `error` level, so HTTP failures and thrown exceptions land in one number
  rather than two definitions that disagree.

## 9. Ingest gateway

Ingest is a **persistent WebSocket stream**, not a series of REST posts. The client opens
one connection per process and keeps it open, pushing batches as they are produced.

`wss://logs.example.com/v1/stream?service=public-api&env=prod`, with
`Authorization: Bearer lgb_<key_id>_<secret>` on the handshake request.

### Handshake

Everything security-related happens once, at connection time:

1. **Parse the key.** Split `lgb_<key_id>_<secret>`; look up by `key_id` (indexed); compare
   `secret` against `secret_hash` in constant time. Keys are high-entropy random, so
   SHA-256 is sufficient and fast. Unknown or disabled key → close `4401`.
2. **Check the IP.** The socket address, resolved through `TRUSTED_PROXY_HOPS`, must match
   the key's `ip_allowlist`, or the global allowlist if the key has none. CIDR matching is
   done in application code, since SQLite has no network types. Mismatch → close `4403`,
   recorded with the offending IP.
3. **Check write scope.** The query string's `service` must be in the key's
   `service_scope`, and `env` in its `env_scope` when one is set. Mismatch → close `4403`.

The connection is then **pinned** to that `(key, service, env)` triple for its lifetime,
and individual messages cannot name a service or env at all. This is strictly stronger
than the REST design it replaces, where every request had to be re-checked and a bug in
any one code path could let a key write outside its scope. Here it is structurally
impossible: a compromised `chat-ws` host cannot forge `office-api` logs, and a staging
host cannot pollute prod.

On success the server sends `hello` with the limits the client must respect:

```json
{ "t": "hello", "maxEntriesPerBatch": 500, "maxBatchBytes": 1048576, "ackWindow": 8 }
```

### Frames

Client → server:

```json
{ "t": "batch", "id": "01JD8Z...", "entries": [
    { "ts": "2026-11-23T20:00:00.000Z", "level": "info", "kind": "request",
      "msg": "GET /v1/users 200",
      "dims": { "company_id": "acme", "user_id": "u_123" },
      "meta": { "status": 200, "duration_ms": 42 } } ] }
```

Server → client: `{"t":"ack","id":"..."}`, or
`{"t":"nack","id":"...","reason":"...","retryable":true|false}`.

`id` is a client-generated ULID, stable across every retransmission of that batch. `kind`
is optional and set only by the Express middleware.

**Acks are the heart of the protocol.** The client does not consider a batch delivered —
and does not delete it from its spool — until the matching `ack` arrives. A client holds
at most `ackWindow` batches in flight, which doubles as backpressure: a slow or struggling
gateway naturally slows its clients instead of being flooded by them.

### Per-batch handling

1. **Validate and normalise.** Clamp timestamps to a sane window, cap line length, cap
   structured-metadata entries and bytes (Loki's 128-entry / 64KB limits), coerce unknown
   levels to `info`. A malformed batch gets a non-retryable `nack`, so the client discards
   it instead of looping on it forever.
2. **Deduplicate.** Insert `id` into `ingest_batches`. A conflict means this batch already
   landed, so `ack` immediately and do nothing else. This is what makes reconnection safe:
   the client resends everything unacked, and without dedupe those resends would
   double-count usage, since rollup upserts are additive.
3. **Roll up usage.** Coalesce into per-hour, per-depth counters and upsert `usage_rollup`
   in the same transaction as the dedupe insert.
4. **Fan out to live subscribers.** Publish the entries to an in-process bus that any
   connected console is subscribed to, so they reach the browser in milliseconds. This
   happens before the Loki push, because live tail must not wait on storage. Delivery is
   best-effort and lossy by design: a slow subscriber is skipped rather than allowed to
   back up ingest, since the durable copy is going to Loki regardless.
5. **Push to Loki.** Group entries into streams by `(service, env, level)` and POST to
   `/loki/api/v1/push` with structured metadata. On failure, roll back steps 2-3 and send
   a retryable `nack`, so the counters never drift from what is actually stored.
6. **Ack.**

### Live fan-out

The gateway keeps a per-service ring buffer of the last ~1000 entries, and an internal
subscription endpoint the console connects to:

`GET /internal/subscribe` (WebSocket, authenticated with a shared secret), taking a filter
— services, envs, levels, dimension matchers — applied **server-side**, so a busy stream
does not flood the browser with lines it will discard. On subscribe, the matching contents
of the ring buffer are sent first, so opening the tail shows immediate context instead of
an empty screen.

### Connection lifecycle

- **Keep-alive:** WebSocket ping every 30 seconds; the connection is dropped after two
  missed pongs, so a half-open TCP connection cannot silently swallow logs.
- **Revocation is prompt.** Because connections are long-lived, revoking a key must also
  close its open sockets, not merely reject future handshakes. The console calls a small
  authenticated internal endpoint on the gateway (`POST /internal/reload`) after any key
  change, and the gateway also polls a `config_version` row every few seconds as a
  fallback, so a missed call costs seconds rather than leaving a revoked key streaming.
- **The store is a local file**, so "the database is unreachable" is not a failure mode at
  all: there is no network between the gateway and its data. What
  remains is a full disk or a corrupt file, both of which fail closed with `4503` on new
  handshakes and are surfaced on `/health`.
- A per-key cap on concurrent connections and on batches per second.
- `GET /health` for the proxy, and the gateway's own logs go to stdout — it never logs
  into itself, to avoid a feedback loop.

### HTTP fallback

`POST /v1/logs` is retained with the same validation, dedupe, and rollup path. It exists
for `curl` debugging, for environments where outbound WebSocket is blocked, and as a
safety valve if the stream proves troublesome. It is not the primary path, and the client
uses it only when explicitly configured to. *(Author's call — nearly free, since it reuses
the same handlers.)*

Loki runs with `auth_enabled: false` and a single tenant. Multi-tenancy would buy nothing
here: companies are data, not tenants, and there is exactly one reader. Isolation comes
from the gateway plus network placement.

## 10. Node client module

`@logguber/client`, consumed as a local workspace dependency (pnpm workspace link), built
to both ESM and CommonJS so it works in any of the services regardless of module system.

```ts
const log = createLogger({
  url: process.env.LOGGUBER_URL,        // wss://logs.example.com/v1/stream
  apiKey: process.env.LOGGUBER_KEY,
  service: 'public-api',
  env: process.env.NODE_ENV,
  spool: { dir: '/var/lib/logguber' },  // SQLite fallback, see below
});

log.info('cache warmed', { dims: { company_id: 'acme' } });
const reqLog = log.child({ dims: { company_id: 'acme', user_id: 'u_123' } });

app.use(log.expressMiddleware({
  resolveDims: (req) => ({ company_id: req.auth?.companyId, user_id: req.auth?.userId,
                           api_key_id: req.auth?.keyId }),
  ignore: (req) => req.path === '/health',
}));
```

### Three stages, one direction

```
log.info()  ──>  in-memory queue  ──>  WebSocket  ──ack──>  done
                        │                  ▲
                   (unreachable)           │ (reconnected: drain oldest first)
                        ▼                  │
                   SQLite spool  ──────────┘
```

- **Non-blocking.** Log calls enqueue and return synchronously. Nothing in the client ever
  throws into application code; transport problems go to an `onError` hook that defaults
  to a single rate-limited `console.warn`.
- **Batched.** A batch is cut when the queue reaches N entries or T milliseconds elapse,
  whichever comes first (defaults ~100 / ~1000ms), within the server's `hello` limits.
- **Streamed.** One WebSocket per process, reconnecting with exponential backoff and
  jitter. Close codes in the 4401/4403 family are permanent — bad credentials will not fix
  themselves — so the client stops reconnecting and reports loudly instead of hammering
  the gateway forever. Everything else is treated as transient and retried.
- **Spooled when unreachable.** Whenever the socket is down, or a batch goes unacked past
  its timeout, that batch is written to a local SQLite database rather than held in memory
  or dropped. On reconnect the client drains the spool oldest-first, interleaved with live
  traffic, deleting each row only once its `ack` arrives. An outage becomes a delay instead
  of a hole in the logs.
- **Drained on shutdown.** `await log.flush()`, plus optional `SIGTERM`/`beforeExit`
  handlers. Anything still undelivered is written to the spool before exit, so a rolling
  deploy loses nothing: the next process start picks it up.
- The Express middleware emits one line per completed request with method, path, matched
  route, status, duration, and request id, at `error` level for 5xx and `warn` for 4xx.

### The SQLite spool

- One database file per spool directory, opened in WAL mode with a busy timeout, so
  several worker processes can share it safely. Rows are claimed inside a transaction so
  two workers never send the same batch — and if they somehow did, the gateway's dedupe
  would absorb it.
- One table: `spool(id TEXT PRIMARY KEY, body BLOB, created_at INTEGER, attempts
  INTEGER)`. Bodies are the serialised batch, so draining needs no re-encoding.
- **Only used while the server is unreachable**, as specified. While the stream is healthy
  nothing touches the disk, so the normal path costs no I/O. The trade-off this accepts: if
  a process is hard-killed while connected, the entries sitting in its memory queue — at
  most one flush interval's worth — are lost. A `spool: { mode: 'always' }` option writes
  every batch to disk before sending, for full crash durability at the cost of one disk
  write per batch. Default is on-failure.
- **Bounded.** `maxBytes` (default 256MB) and `maxAge` (default 7 days). On overflow the
  oldest rows are pruned, the pruned count is tracked, and that count is reported to the
  gateway on the next successful batch — so loss shows up in the console instead of being
  silent. Filling the host's disk would be worse than losing logs.
- **Loki's out-of-order window matters here.** Replayed entries keep their original
  timestamps, and Loki rejects samples older than `reject_old_samples_max_age`. That is set
  to 7 days in the Loki config to match the spool's `maxAge`, so a long outage replays
  successfully rather than being refused at the end of it. The two values must move
  together, and are documented as a pair.
- Implemented with `better-sqlite3` (prebuilt binaries, synchronous API — fine here,
  because disk access happens only on the offline path and in batches). *Author's note:*
  this is a native dependency, meaning prebuilds per Node version and care on Alpine/musl
  images. On Node 24+ the built-in `node:sqlite` removes the native dependency entirely
  and is a drop-in swap behind the spool's interface, which is kept deliberately narrow
  for exactly that reason.

### Redaction and body capture

This is the part that matters most, because the logs will contain headers and bodies.

**Headers are allowlisted, not denylisted.** Only an explicit set is captured — by default
`host`, `user-agent`, `content-type`, `content-length`, `accept`, `referer`,
`x-request-id`. Everything else is dropped, so `authorization`, `cookie`, `set-cookie`,
and the next header someone invents to carry a token can never leak by omission. A
denylist would be one forgotten entry away from shipping credentials.

**Bodies are redacted by key, at any depth.** A default case-insensitive key list —
`password`, `pass`, `token`, `secret`, `apikey`, `api_key`, `authorization`, `credential`,
`card`, `cardnumber`, `cvv`, `ssn`, `otp`, `refresh_token` — is replaced with
`"[redacted]"` in place, preserving the surrounding structure so the log still shows the
shape of what happened. The list is extendable per service, and strict services can invert
it to an allowlist (`bodyFields: ['orderId', 'status']`), capturing nothing else.

**All of this runs in the client, before the entry is queued.** Secrets therefore never
cross the network, never enter the gateway's memory, and never land in the on-disk spool —
which matters, because that spool is a plaintext file on an application host.

**Body capture is a policy, not a boolean**, because bodies dominate storage:

| mode | behaviour |
|---|---|
| `never` | metadata only |
| `on-error` | bodies kept only for 4xx/5xx responses — **the default** |
| `sample` | bodies for all errors plus a configurable fraction of successes |
| `always` | every request and response body |

`on-error` is the default because it captures what is almost always wanted for debugging
at a small fraction of the bytes; `always` is one config line away if full audit is worth
the storage. *Author's call, flagged in section 15 — it directly determines disk growth.*

Capturing a **response** body means wrapping `res.write`/`res.end`, which is a known way
to break streaming responses if done carelessly. The middleware therefore skips capture
entirely for streaming and non-JSON content types (`text/event-stream`, `multipart/*`,
anything not JSON-ish) and caps what it buffers, so a large download is never held in
memory.

### Adoption

**Assumption, flagged for correction:** the services adopt this logger directly, i.e. they
are on `console.log` today rather than pino or winston. If any service is already on a real
logger, replacing it across four codebases is more churn than it is worth, and the better
path is a transport feeding the existing `logger.info()` calls into Logguber. To keep that
cheap, the client exposes its batching-and-spooling sink as a documented low-level
`createSink()` API that a pino transport or winston stream can wrap in a few dozen lines.

## 11. Next.js console

Server-side only for data access: neither Loki nor the SQLite file is ever exposed to the
browser, and no API key reaches client-side code.

Screens:

- **Search** — time range picker, service/env/level filters, dimension filters built from
  the configured levels, free-text and regex line matching, results table with expandable
  structured metadata. Filters compile to LogQL in `packages/shared` so the gateway and
  console agree on semantics.
- **Live tail** — instant. A Next.js route handler holds one WebSocket subscription to the
  gateway's `/internal/subscribe` and relays matching entries to the browser over SSE, so
  the browser only ever talks to the console's own origin and reuses the existing session
  auth. Lines appear as the gateway accepts them, with no storage round trip. The ring
  buffer gives immediate context on open; filters, pause/resume, and JSON line expansion
  work on the live stream. Loki's tail endpoint is used only for tailing from a past
  timestamp, or when the gateway has restarted and its buffer is cold.
- **Usage** — the headline feature. Time series of requests and log volume, grouped by the
  first configured level, drillable down the hierarchy with breadcrumbs. Served from
  `usage_rollup`, so it is fast over long ranges. Tables of top companies, top users,
  error rates per client. Dimension values are raw IDs by default; where a
  `dimension_labels` row exists the display name is shown with the ID as a subtitle, so
  `acme` can read as "Acme Ltd" without the ingest contract having to carry names.
- **Admin** — create and revoke API keys (secret shown once at creation), edit per-key
  service scope and IP allowlist, edit the global IP allowlist, edit the dimension
  hierarchy, name dimension values, view recent ingest rejections, set retention.

Console auth: email and argon2id password against `operators`, session in a signed
HTTP-only cookie, first account seeded by a CLI command. Optionally the whole console sits
behind an IP allowlist too, enforced in middleware.

## 12. Retention and storage

Loki single-binary with the filesystem object store by default, with MinIO available in
compose for those who want S3 semantics. Compactor enabled with retention on;
`retention_period` defaults to 30 days and is settable from the console.

**Bodies change the sizing arithmetic.** A metadata-only API log line is a few hundred
bytes; the same line carrying a request and response body is kilobytes. That is the
reason body capture defaults to `on-error`, and the reason `level` is a Loki label:
per-stream retention rules can keep what matters longer than what does not —

```yaml
retention_stream:
  - selector: '{level="error"}'
    period: 90d
  - selector: '{level=~"debug|info"}'
    period: 14d
```

Errors, which carry the bodies worth having, are kept for a quarter; routine traffic ages
out in a fortnight. Both periods are editable from the console.

`usage_rollup` stays small — per hour, one row per active hierarchy prefix, so its growth
tracks how many clients actually send traffic rather than log volume — and is kept
indefinitely, so year-over-year client usage survives even after the raw logs expire.
This is a deliberate split: logs are transient, usage history is permanent.

## 13. Testing strategy

Test-driven, with weight concentrated where failure is expensive:

- **Handshake auth and scoping** — the highest-value tests in the project. Wrong key,
  disabled key, key writing outside its service scope, request from a non-allowlisted IP,
  spoofed `X-Forwarded-For` beyond the trusted hop count, a key writing to an env outside
  its `env_scope`, attempts to inject extra Loki labels. Each must be rejected, and each
  gets a test.
- **Limits** — oversized lines, too many metadata entries, absurd timestamps, and bodies
  large enough to hit the client's truncation path (asserting the result is still valid
  JSON that Loki will accept).
- **Redaction** — the other highest-value suite, since a miss here leaks credentials.
  `Authorization` and `Cookie` headers never appear in output; nested and deeply nested
  secret keys are redacted; arrays of objects are walked; allowlist-only mode captures
  nothing extra; redaction happens before the spool, verified by inspecting the SQLite
  file directly after an offline write.
- **Live fan-out** — an entry reaches a subscriber before the Loki push resolves; filters
  are applied server-side; a stalled subscriber is dropped instead of blocking ingest; the
  ring buffer replays on subscribe.
- **Response capture safety** — a streaming/SSE response passes through the middleware
  unbuffered and unbroken.
- **Client transport** — batching and flush timing with fake timers, reconnect backoff,
  permanent-versus-transient close codes, ack window enforcement, drain on shutdown, and
  that a dead server never throws into application code.
- **Spool** — the scenario that justifies the whole feature: kill the gateway mid-stream,
  keep logging, assert rows accumulate in SQLite, restart the gateway, then assert every
  entry arrives exactly once and the spool empties. Plus `maxBytes`/`maxAge` pruning with
  accurate drop counts, concurrent workers sharing one file, and replay of entries old
  enough to brush Loki's out-of-order window.
- **Revocation** — revoking a key closes its live sockets, not just future handshakes.
- **LogQL builder** — unit tests on filter-to-query compilation, including escaping.
- **Rollups** — prefix-row correctness at every depth, `dims` normalisation (unknown
  values, key order), coalescing within a batch, and idempotency: replaying the same
  `batch_id` must not move a single counter.
- **Degraded modes** — Loki down (rollback, retryable nack, no counter drift), disk full,
  and concurrent writers contending on the SQLite lock.
- **End-to-end** — compose up Loki, stream through the client, assert the line is
  searchable and the usage counters moved at every depth.

## 14. Left to the builder

- Next.js UI styling and component library; chart library choice for the usage screens.
- SQLite migration tooling and WAL/pragma tuning.
- Internal structure of the LogQL builder.
- Fastify plugin layout and validation library.
- Exact default batch sizes, flush intervals, and rate limits, tuned during development.
- Dockerfile specifics and compose networking details.
- Whether live tail uses SSE or WebSocket, if SSE proves awkward through Next.js.

## 15. Calls made while writing this up

Decisions taken by the author rather than the operator, flagged so they can be overridden:

- A SQL store added for usage rollups, keys, and options (section 7), revising the earlier
  "Loki alone is enough" assumption. Per the operator, that store is SQLite; the data-access
  layer is kept thin so Postgres remains a contained swap if volume ever demands it.
- Loki runs single-tenant with `auth_enabled: false` rather than per-company tenants
  (section 9).
- Exactly three Loki labels, with client-supplied labels ignored rather than merged
  (section 8).
- Dimension config stored in the database and editable in the UI, rather than in a file.
- Usage rollups retained indefinitely while raw logs expire.
- Single operator account with password auth, seeded by CLI; no OAuth or SSO.
- Usage rollups stored one row per hierarchy prefix rather than per full combination, so
  each drill level reads pre-aggregated rows (section 8).
- `requests` counted from an explicit `kind: "request"` marker set only by the Express
  middleware; `errors` defined as error/fatal-level lines rather than 5xx status, so the
  two never disagree (section 8).
- Client-generated `batch_id` plus a 24-hour dedupe ledger, making retries safe for
  additive counters (section 9).
- API keys scoped by `env` as well as `service`, so a staging host cannot write prod
  (section 9). Cheap now, a migration plus key rotation later.
- Caddy in compose as the single TLS-terminating entry point, with one trusted proxy hop
  by default (section 7).
- Key revocation closes live sockets via an internal reload call plus a `config_version`
  poll, since SQLite has no `LISTEN`/`NOTIFY` (section 9).
- Optional `dimension_labels` table for human-readable client names, keeping names out of
  the ingest contract (section 8).
- Client built as dual ESM/CommonJS, removing any question of what the existing services
  can import (section 10).
- The WebSocket connection is pinned to one `(key, service, env)` triple, so messages
  cannot name a service at all — scope violations become structurally impossible rather
  than check-dependent (section 9).
- Ack-per-batch with a bounded in-flight window, serving as both the delivery guarantee
  and the backpressure mechanism (section 9).
- `POST /v1/logs` retained as a debugging and blocked-WebSocket fallback (section 9).
- Spool defaults to on-failure only, trading a one-flush-interval loss window on hard kill
  for zero disk I/O on the healthy path; `mode: 'always'` is available (section 10).
- Spool bounded at 256MB / 7 days, with Loki's `reject_old_samples_max_age` set to match so
  that long outages actually replay (section 10).
- `better-sqlite3` for both the client spool and the server store, behind interfaces narrow
  enough to swap for `node:sqlite` on Node 24+ (section 10).
- A low-level `createSink()` export, so a pino or winston transport is a small later
  addition rather than a refactor (section 10).
- The Loki line is a JSON object with the filterable fields duplicated into structured
  metadata, rather than everything flattened into metadata (section 8).
- Headers are captured by allowlist and body keys redacted by denylist, in the client,
  before queueing or spooling (section 10).
- Body capture defaults to `on-error`; `always` is available and roughly an order of
  magnitude more storage (section 10).
- Client-side body truncation at 8KB with a structural marker, plus server-side
  `max_line_size_truncate` as a backstop (section 8).
- Live tail is served by gateway fan-out over an internal subscription, relayed to the
  browser as SSE by the console, with Loki's tail reserved for historical tailing
  (sections 9 and 11).
- Per-level retention streams: errors 90 days, routine traffic 14 days (section 12).
