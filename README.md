# Logguber

Self-hosted logs and per-client API usage for your own Express services.

Your services stream logs over a persistent WebSocket to a gateway, which stores
them in Loki and counts usage as they pass. A Next.js console searches the logs,
tails them live, and shows how much each client company uses your APIs.

```
Express app ──┐
Express app ──┼── @logguber/client ──WSS (acked stream)──> ingest gateway
Express app ──┘      └─ SQLite spool (while unreachable)      │        │
                                                              │        └─> SQLite
                                                              ▼             (keys, options,
                                                            Loki             usage counters)
                                                              ▲                   ▲
                                      Next.js console ────────┴───────────────────┘
```

Four parts:

| Path | What it is |
|---|---|
| `packages/client` | The npm package your Express services install. |
| `apps/ingest` | The gateway. The only thing that writes to Loki, and where all auth lives. |
| `apps/web` | The console: search, live tail, usage, admin. |
| `packages/shared` | The wire protocol both sides agree on. |

## Run it

Needs Node 24+ and pnpm. For the real deployment you also need Docker.

```bash
pnpm install
cp .env.example .env     # then fill in both secrets: openssl rand -hex 32
docker compose up -d --build
```

Create an operator login and a key per service:

```bash
pnpm --filter @logguber/ingest seed operator you@example.com 'a-long-password'
pnpm --filter @logguber/ingest seed key office-api office-api prod
pnpm --filter @logguber/ingest seed key public-api public-api prod
pnpm --filter @logguber/ingest seed key chat-api  chat-api  prod
pnpm --filter @logguber/ingest seed key chat-ws   chat-ws   prod
```

Each key's secret is printed once and only its hash is stored. A key is scoped to
the services and environments it may write, so a compromised host can only forge
its own logs.

Then open the console (`https://localhost` behind Caddy, or `pnpm --filter
@logguber/web dev` on port 3000 while developing).

### In your Express service

```js
import { createLogger } from '@logguber/client'

const log = createLogger({
  url: process.env.LOGGUBER_URL,   // wss://logs.example.com/v1/stream
  apiKey: process.env.LOGGUBER_KEY,
  service: 'public-api',
  env: process.env.NODE_ENV,
  spool: { dir: '/var/lib/logguber' },
})

app.use(log.expressMiddleware({
  resolveDims: (req) => ({
    company_id: req.auth?.companyId,
    user_id: req.auth?.userId,
    api_key_id: req.auth?.keyId,
  }),
  ignore: (req) => req.path === '/health',
}))

process.on('SIGTERM', () => log.close())
```

`packages/client/README.md` has the full option list, the redaction rules, and the
body-capture modes.

## The things worth knowing

**An outage costs delay, not logs.** When the gateway is unreachable the client
writes batches to a local SQLite file and replays them on reconnect, deleting each
only once the gateway acknowledges it. Claims expire after 60s so a process killed
mid-replay doesn't orphan its rows, and the gateway deduplicates on batch id so a
replay can't double-count your usage numbers.

**Secrets are redacted in your process, before anything is sent.** Headers are
captured by allowlist — anything not on the list is dropped, so a new auth header
can't leak by omission — and body keys matching `password`/`secret`/`token`/
`credential`/`apikey`/`privatekey` are replaced at any depth. Nothing redacted ever
reaches the network or the on-disk spool. One known limit: a key spelled with a
Unicode homoglyph is not matched.

**Request bodies are captured only for errors** by default. A metadata-only line is
a few hundred bytes; the same line with request and response bodies is kilobytes.
`always` is one config line away if you want it.

**Usage is counted at ingest, not queried from logs.** Loki has no index on company
or user, so a 30-day usage chart would otherwise scan 30 days of logs on every page
load. Counters are stored per hour per hierarchy prefix, which also means they
survive after the raw logs age out — errors are kept 90 days, routine traffic 14.

**The drill-down hierarchy is configurable.** `service → company → user` by default,
editable in Admin. Only `service` is a Loki label; everything else is structured
metadata, which is why adding a level is cheap and doesn't need a migration. A new
level starts recording from the moment you add it; older lines show `unknown`.

**Live tail is actually live.** The gateway fans each accepted line out to the
console before pushing to Loki, because Loki's own tail endpoint lags by design.

## Checks

```bash
pnpm vitest run                      # 294 tests, the client package
node apps/ingest/smoke.mjs           # client -> gateway -> Loki, usage counters, live fan-out
node verify.mjs                      # the whole stack, every console page over HTTP
```

`smoke.mjs` and `verify.mjs` stand up a fake Loki, so they run without Docker.

## Design and decisions

`docs/superpowers/specs/2026-11-23-logguber-design.md` is the design, including the
trade-offs that were taken deliberately and the limits that were accepted rather
than fixed.
