# @logguber/client

A logger for Express services that streams to a Logguber gateway over WebSocket. When the gateway is unreachable it spools to a local SQLite file, so an outage costs delay rather than lost logs.

## Install

The package is private and consumed as a workspace dependency:

```json
{ "dependencies": { "@logguber/client": "workspace:*" } }
```

Requires **Node 24 or newer** (the spool uses the built-in `node:sqlite`). Both ESM (`import`) and CommonJS (`require`) are supported.

## Quick start

```js
import express from 'express'
import { createLogger } from '@logguber/client'

const log = createLogger({
  url: process.env.LOGGUBER_URL,     // e.g. wss://logs.example.com/ingest
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

Other constructor options: `dims` (stamped on every entry), `batch` (`maxEntries`, `maxMs`, `maxQueue`), `backoff` (`baseMs`, `maxMs`), `headerAllowlist`, `redactKeys`, `onError`.

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
