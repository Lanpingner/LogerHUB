# Logguber

Self-hosted logs and per-client API usage for your own Express services.

Your services stream logs over a persistent WebSocket to a gateway, which stores
them in Loki and counts usage as they pass. A Next.js console searches the logs,
tails them live, and shows how much each client company uses your APIs.

```
Express app ──┐
Express app ──┼── @leviathan.systems/logerhub-client ──WSS (acked stream)──> ingest gateway
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

## Deploy it

One server runs everything: Loki, the ingest gateway and the console. TLS is
terminated by your own reverse proxy; a ready nginx config is included.

```bash
git clone <this repo> && cd Logguber
cp .env.example .env
```

Fill in `.env`:

```bash
CONSOLE_SECRET=$(openssl rand -hex 32)   # console to gateway, internal only
SESSION_SECRET=$(openssl rand -hex 32)   # signs the operator's session cookie
TRUSTED_PROXY_HOPS=1                     # your nginx; add one per extra hop
INGEST_BIND=127.0.0.1:8080               # change if the port is taken
WEB_BIND=127.0.0.1:3000
```

```bash
docker compose up -d --build
```

The containers publish to **loopback only** — nothing is exposed to the
internet until your proxy forwards to them.

Then point nginx at them. Copy `deploy/nginx.conf`, change `server_name` and
the certificate paths, and reload:

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/logerhub
sudo ln -s /etc/nginx/sites-available/logerhub /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Three parts of that config are load-bearing, and the usual symptoms if they are
missing:

| Location | What it needs | If it is missing |
|---|---|---|
| `/v1/stream` | `Upgrade`/`Connection` headers, `proxy_read_timeout 3600s` | Your services reconnect every 60 seconds, forever |
| `/api/live` | `proxy_buffering off`, `gzip off` | Live tail shows nothing and looks broken |
| everything | `X-Forwarded-For` via `$proxy_add_x_forwarded_for` | Per-key IP allowlists match the proxy, not the caller |

`TRUSTED_PROXY_HOPS` must equal the number of proxies in front. One nginx is
`1`; nginx behind Cloudflare is `2`. The gateway reads the client address that
many entries from the right of `X-Forwarded-For`, so a wrong number means the
IP allowlist checks the wrong address.

Create your login and one key per service:

```bash
docker compose exec -e LOGGUBER_DB=/data/logguber.db ingest \
  node --experimental-strip-types apps/ingest/src/seed.ts operator you@example.com 'a-long-password'

docker compose exec -e LOGGUBER_DB=/data/logguber.db ingest \
  node --experimental-strip-types apps/ingest/src/seed.ts key office-api office-api prod
```

Each key's secret prints once; only its hash is stored. Repeat per service.

### If you would rather not run a proxy

Caddy is included and will get certificates automatically:

```bash
echo 'LOGGUBER_DOMAIN=logs.example.com' >> .env
docker compose --profile tls up -d
```

It publishes 80 and 443 and handles everything above for you. Skip it entirely
when your own nginx is in front — it is off by default.

### What runs where

| Service | Port | Reachable from |
|---|---|---|
| caddy | 80, 443 | the internet |
| web (console) | 3000 | caddy only |
| ingest (gateway) | 8080 | caddy only, on `/v1/*` and `/health` |
| loki | 3100 | gateway and console only |

Your services connect to `wss://<your domain>/v1/stream`. The console is on the
same domain, so there is one certificate and no CORS.

### Checking it works

```bash
curl https://<your domain>/health

curl -X POST https://<your domain>/v1/logs \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"batch_id":"test-1","service":"office-api","env":"prod","entries":[
       {"ts":"2026-11-24T09:51:02.124Z","level":"info","msg":"hello"}]}'
```

A `202 {"accepted":1}` means the whole path works: auth, scope check, counters
and the Loki write.

### Updating

```bash
git pull && docker compose up -d --build
```

The SQLite store and Loki's chunks live in named volumes, so they survive a
rebuild. Back up by copying the `store` volume — it is one file.

### Keeping it on one host

The gateway and the console share one SQLite file, so they must stay on the same
machine. That is a deliberate ceiling, not an oversight: it keeps the deployment
to four containers and one file to back up. Splitting them across machines — or
putting that file on NFS, which breaks SQLite's locking — means moving to
Postgres first. All database access sits behind one thin module so that swap is
contained.

## Developing

```bash
pnpm install
docker run -d --name loki -p 3100:3100 \
  -v "$PWD/deploy/loki.yaml:/etc/loki/loki.yaml:ro" grafana/loki:3.7.5 -config.file=/etc/loki/loki.yaml

pnpm --filter @logguber/ingest dev     # gateway on 8080
pnpm --filter @logguber/web dev        # console on 3000
node traffic.mjs                       # optional: simulated traffic
```

### In your Express service

```js
import { createLogger } from '@leviathan.systems/logerhub-client'

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
