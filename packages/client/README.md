# @leviathan.systems/logerhub-client

One logger for Express and WebSocket services: it prints to your terminal and streams to a LogerHUB gateway in the same call. When the gateway is unreachable it spools to a local SQLite file, so an outage costs delay rather than lost logs.

## Install

```bash
npm install @leviathan.systems/logerhub-client
```

Requires **Node 24 or newer** (the spool uses the built-in `node:sqlite`). Both ESM (`import`) and CommonJS (`require`) are supported, with TypeScript declarations for each. The only runtime dependency is `ws`.

## Quick start

```js
import express from 'express'
import { createLogger } from '@leviathan.systems/logerhub-client'

const log = createLogger({
  url: process.env.LOGGUBER_URL,     // wss://logs.example.com/v1/stream
  apiKey: process.env.LOGGUBER_KEY,
  service: 'office-api',
  env: 'production',
  spool: { dir: '/var/lib/office-api/logguber' },
})

const app = express()
app.use(express.json())

app.use(log.expressMiddleware({
  // Runs when the response finishes, so req.user is already populated.
  resolveDims: (req) => ({
    company_id: req.user?.companyId,
    user_id: req.user?.id,
    api_key_id: req.apiKey?.id,
  }),
}))
```

The middleware writes one `kind: 'request'` entry per HTTP request, carrying method, matched route pattern (never the raw path, so cardinality stays bounded), status, duration, request id and the redacted headers. The `resolveDims` values are what per-client usage counts are derived from. Values that are not strings (including `undefined`) are left out of the entry.

Mount it after your body parser and after any middleware that populates `req.user`, though dims are read at the end of the request so ordering only matters for body capture. Use `ignore: (req) => req.path === '/healthz'` to skip a request entirely.

Plain logging works too:

```js
log.info('invoice sent', { dims: { company_id: '42' }, meta: { invoiceId: 'inv_1' } })
log.error('payment failed', { meta: { orderId } })
const child = log.child({ dims: { company_id: '42' } })
```

Every log method takes extra arguments, which are joined into the message. An `Error` contributes its stack, so `log.error('charge failed:', err)` keeps the stack instead of dropping it:

```js
log.info('order', { sku: 'A1', qty: 2 })   // → 'order {"sku":"A1","qty":2}'
log.error('charge failed:', err)           // → 'charge failed: Error: ...\n    at ...'
```

A trailing object whose only keys are `dims`, `meta` and/or `kind` is read as options rather than as part of the message. Any other object is message content, so `log.info('order', { sku: 'A1' })` logs the object and does not silently become metadata.

Other constructor options: `dims` (stamped on every entry), `batch` (`maxEntries`, `maxMs`, `maxQueue`), `backoff` (`baseMs`, `maxMs`), `headerAllowlist`, `redactKeys`, `console`, `onError`.

## Local console output

The client can also be the terminal logger, so one call both prints locally and streams to the gateway. It is off by default — a logging library should not write to your stdout uninvited:

```js
const log = createLogger({
  // ...
  console: {
    enabled: true,
    level: 'debug',     // local floor; the gateway still receives everything
    pending: true,      // redraw in-flight requests at the bottom of the terminal (TTY only)
    file: './log/logfile.log',   // also append the uncoloured line
  },
})
```

Lines are printed **after** redaction, so a secret cannot reach the screen either.

`color` defaults to whether the stream is a TTY and can be forced either way; `NO_COLOR` always wins.

`pending` is different: it draws the in-flight block by moving the cursor, which only means anything on a real terminal, so it is **ignored unless stdout is a TTY** — whatever `color` says. Under PM2, systemd, Docker or any redirect, stdout is a file and the block stays off, because cursor movement written into a file does nothing and every redraw would stack another copy of the block instead of replacing it. You get plain finished lines there, which is what a log file should hold anyway.

Two layouts, both fixed (they are pinned by tests, because people read them):

```
2026-11-24 11:13:44 INFO  [index.js]: cache warmed
11:13:44     +4ms GET     [APR] [a1b2c3d4] /users/1 from 127.0.0.1 app:OFF ip-exc user:42 — 200 (cached)
11:13:44     +0ms GET     [a1b2c3d4] /users/1 from 127.0.0.1 — pending...
```

On request lines the duration column shows server time then transit time, `12ms+3ms`, so a slow response reads as slow code or slow delivery at a glance. Set `timing` to choose:

- `timing: 'split'` (default): `12ms+3ms`. The column is wider than the original. A request with no first byte observed (aborted before any write) falls back to the total, `+15ms`, in the same column.
- `timing: 'total'`: the original single `+15ms` layout, byte for byte, as shown above. This is the one-word way back if you compare lines against a logger with that layout.

App-reported phases (`logger.time`) are not drawn on the line; read them in the gateway.

The non-request label defaults to the entry script's filename, then to the service name; set `label` to override it.

### Decorating the request line

Four keys in `meta.http` are reserved, and the console renders them. They are ordinary metadata too, so the gateway stores them and you can search on them:

| Key | Renders as |
|---|---|
| `auth: { type, cached }` | the `[APR]` tag — letters that ran are coloured (purple cached, red live), the rest dimmed |
| `tags: { app: 'OFF' }` | ` app:OFF`; a value of `true` renders as a bare word, so one ordered record controls the whole sequence |
| `flags: ['ip-exc']` | ` ip-exc` |
| `note: 'cached'` | ` (cached)` |

Supply them from `resolveMeta`, which runs when the response finishes:

```js
app.use(log.expressMiddleware({
  pending: true,
  captureIp: true,
  requestId: (req) => req.id,          // reuse an id you already assigned
  resolveMeta: (req, res) => ({
    auth: res.authType ? { type: res.authType, cached: Boolean(res.authCached) } : undefined,
    tags: { app: req.app_id_prefix, 'ip-exc': req.ip_exception || undefined, user: req.userid },
  }),
  note: (req, res) => res.authReason,
  ignore: (req) => req.path === '/metrics' || req.path === '/internal/log',
}))
```

`resolveMeta` cannot overwrite the measured fields (`status`, `duration_ms`, `server_ms`, `transit_ms`, `method`, `route`, `request_id`): usage counts are derived from those. The tag letters are configurable with `authTagLetters` and `authTagAlways` on the `console` options.

`captureIp` is off by default, because an IP is personal data. With it on, `trustProxyHops` says how many of your own proxies to trust; the chain is read from the right, since a client can append to `x-forwarded-for`.

A request is flagged `preflight` in `meta.http.flags` when it is a CORS preflight: the method is `OPTIONS` and both an `Origin` and an `Access-Control-Request-Method` header are present. A bare `OPTIONS` without them is not flagged. Preflights are counted in request totals and latency percentiles like any other request, and a `flags` array from `resolveMeta` is merged with the flag rather than replaced.

## Phase timings

Every request line splits `duration_ms` into `server_ms` (until the first response byte leaves) and `transit_ms` (first byte to finish). To say where the server time went, wrap the work in `logger.time`. It needs no request object, so it works from any depth of the call stack:

```js
// repo/users.js: knows nothing about Express
export const findUser = (id) => log.time('db', () => db.query('select ...', [id]))

app.get('/users/:id', async (req, res) => {
  res.json(await findUser(req.params.id))
})
```

The phases land in `meta.http.timings` (`{ db: 18.4 }`), which the console draws as a waterfall. `logger.time` returns whatever the callback returns (promises included) and rethrows its errors. For code that does not fit a callback, `logger.phase` returns a function that stops the clock, once:

```js
const done = log.phase('render')
try { renderPage() } finally { done() }
```

- The same name recorded twice adds up. A request keeps at most 16 distinct phases, and names are cut to 64 characters. `server` and `transit` are reserved and ignored.
- Outside a request, `time` runs the callback and records nothing. A child logger records into the same request.
- `timings` is absent when nothing was recorded. If `resolveMeta` also returns a `timings` map, the two merge and a recorded phase wins a clash on the same key.
- Phases are self-reported totals, not a partition of server time. Concurrent phases can sum to more than the wall-clock, and time you did not wrap simply is not listed.
- `timings` never contains `server` or `transit`; those stay separate fields so the waterfall adds up.

The first-byte mark lands at your application's first write even behind `compression`, because compression flushes headers (through `writeHead`) before it compresses anything. Gzip time therefore mostly lands in `transit_ms`, not `server_ms`.

## WebSocket traffic

`instrumentWs` logs a `ws` server's connections. It returns a function that detaches it:

```js
import { WebSocketServer } from 'ws'

const wss = new WebSocketServer({ server })
log.instrumentWs(wss, {
  messages: 'meta',          // 'none' (default) | 'meta' | 'payload'
  resolveDims: (req) => ({ company_id: companyFromToken(req) }),
  ignore: (req) => req.url === '/internal',
  pending: true,             // show open connections in the in-flight block
})
```

One entry per connection open, close and error. `close` carries the code, reason, duration and the message counts in each direction. `messages: 'meta'` adds an entry per message with its size and direction; `payload` also captures the body, redacted and size-capped (`maxPayloadBytes`, default 2048) — and only when it parses as JSON, since nothing else can be redacted by key.

Outbound frames are counted by wrapping `send`, because `ws` emits no event for them. The original is always called: the instrumentation never replaces your own listeners, and a failure to log never stops a frame.

### Printing without streaming

`log.printLine(text)` writes a line locally and sends nothing, keeping the in-flight block intact. Use it for banners and startup notices that are not log entries.

## Redaction

Redaction runs inside the client, before anything leaves the process.

**Headers are allowlist-only.** Only these request headers are captured:

`host`, `user-agent`, `content-type`, `content-length`, `accept`, `referer`, `x-request-id`

Every other header is dropped. That is why a new auth header (`x-internal-token`, a vendor signature, anything) cannot leak by omission: it is not captured unless someone adds it. Setting `headerAllowlist` on `createLogger` replaces this list, so name every header you want. `referer` has its query string and fragment stripped (and any userinfo), and is dropped if it is not a parseable URL.

**Body keys** are normalised (Unicode NFKC, lower-cased, everything except `a-z0-9` removed) and then redacted if either:

- they match exactly a default key (`password`, `token`, `secret`, `apikey`, `authorization`, `cookie`, `cvv`, `ssn`, `jwt`, `sessionid`, and similar), or
- they contain one of `password`, `secret`, `token`, `credential`, `apikey`, `privatekey`.

So `Access-Token`, `user_password_hash` and `clientSecret` are all redacted. A bare `key` is deliberately not matched. Matching applies at every depth, including inside JSON strings that parse to an object or array. Redacted values become `[redacted]`.

`redactKeys` **extends** the defaults and never replaces them; you cannot accidentally turn off `password` by passing your own list:

```js
createLogger({ /* ... */ redactKeys: ['iban', 'national_id'] })
```

To narrow rather than extend, use `allowFields` on the middleware. Only those top-level body fields are captured, and they are still redacted:

```js
app.use(log.expressMiddleware({ allowFields: ['orderId', 'status'] }))
```

**Known limit:** a key spelled with a Unicode homoglyph (for example a Cyrillic `а` in `pаssword`) is not redacted, because NFKC folds compatibility forms but not look-alike letters from other scripts. If you do not control who produces the bodies, use `allowFields` or `bodies: 'never'`.

Only parsed objects and arrays are captured. A raw `Buffer` or an unparsed string body is not, since it cannot be redacted by key. If redaction itself fails, the value is replaced by `[unredactable]` rather than passed through.

## Body capture

`bodies` on the middleware controls when request and response bodies are captured:

| Mode | Captures bodies |
|---|---|
| `never` | Never. |
| `on-error` (default) | When the response status is 400 or above. |
| `sample` | On errors, plus a fraction `sampleRate` (0 to 1, default 0) of the rest. |
| `always` | On every request. |

`always` multiplies stored volume by the size of every body, up to `maxBodyBytes` (default 8192) per body; use it for debugging, not as a default. Bodies over `maxBodyBytes` are replaced by a truncation marker.

## The spool

Without a `spool` option the client holds undelivered batches in memory only (bounded by `batch.maxQueue`, oldest dropped first). Pass `spool: { dir }` to keep them on disk:

```js
spool: { dir: '/var/lib/office-api/logguber', maxBytes: 268435456, maxAge: 604800000 }
```

- **Bounds:** 256 MB and 7 days by default. When either is exceeded the oldest batches are pruned.
- **Only used while the gateway is unreachable.** In the default `mode: 'on-failure'` the disk is untouched while the connection is healthy. On reconnect the spool is replayed oldest first.
- **`mode: 'always'`** writes every batch to disk before sending. That costs disk I/O on every batch and buys durability across a crash (a `SIGKILL` or OOM kill loses nothing that was batched).
- **Keep `maxAge` in step with whatever the gateway sets for Loki's `reject_old_samples_max_age`.** The design document specifies 7 days, and the gateway is not built yet, so check the value it actually ships with. If the spool keeps entries longer than Loki accepts them, a long outage replays into rejection.

Give each service its own `dir`. If the spool cannot be opened, the client reports it through `onError` and carries on in memory.

## Shutdown

```js
process.on('SIGTERM', async () => {
  await log.close()
  process.exit(0)
})
```

`await log.flush()` cuts the current batch and waits, briefly (about a second), for the gateway to acknowledge what is outstanding. `await log.close()` does that and then writes anything still unacknowledged to the spool for the next process to replay. Call `close()` on `SIGTERM`: during a rolling deploy the old process is stopped while the gateway may still hold batches it has not acked, and without `close()` those in-memory batches die with the process. (Without a configured `spool`, `close()` can only flush; there is nothing durable to write to.)

## Express 4 and 5

Both are supported and both are covered by the test suite. One normalisation to know about: an empty parsed body (`{}`) is treated as no body on both versions, because Express 4 leaves `{}` where Express 5 leaves `undefined`.

## Failure behaviour

- Nothing throws into application code: the logging calls and the middleware catch their own errors, and the original request always proceeds.
- Log calls are non-blocking: they enqueue and return.
- Internal errors go to `onError`, rate-limited per cause. Without one, the client prints at most one `console.warn` every five seconds.
- Loss is counted and reported, not silent: entries dropped from the memory queue and batches pruned from the spool are reported to the gateway on the next batch (`droppedSinceLast`, `prunedBatchesSinceLast`).
