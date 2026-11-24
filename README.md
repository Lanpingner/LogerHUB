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
make env        # copies .env.example and fills in both secrets
```

`make env` never touches an existing `.env`, so it is safe to run twice. It also
refuses to write anything if `openssl` is missing or fails — an empty
`SESSION_SECRET` would stop every login rather than announce itself — and builds
the file under `umask 077`, so the secrets are never briefly world-readable.

By hand, with the same two properties:

```bash
cs=$(openssl rand -hex 32) && ss=$(openssl rand -hex 32) && [ -n "$cs" ] && [ -n "$ss" ] || echo 'openssl failed'
( umask 077 && cp .env.example .env.new )
sed -i "s|^CONSOLE_SECRET=.*|CONSOLE_SECRET=$cs|; s|^SESSION_SECRET=.*|SESSION_SECRET=$ss|" .env.new
mv .env.new .env
```

Then check the rest of `.env`. **It is gitignored and must stay that way** — it holds the two
secrets, and `SESSION_SECRET` is enough on its own to forge an operator session
cookie and read every log in the console:

```bash
CONSOLE_SECRET=$(openssl rand -hex 32)   # console to gateway, internal only
SESSION_SECRET=$(openssl rand -hex 32)   # signs the operator's session cookie
TRUSTED_PROXY_HOPS=1                     # your nginx; add one per extra hop
INGEST_BIND=127.0.0.1:8080               # change if the port is taken
WEB_BIND=127.0.0.1:3000
```

Then build the images **on a workstation** and let the server pull them:

```bash
# on your workstation
make push                 # build both images and push to the registry

# on the server
make deploy               # pull, restart, and check /health and /login
```

The server never builds, for two reasons: `next build` needs about 2GB of
memory, and pulling a built image beats installing hundreds of packages over
whatever link the server has. `make help` lists the rest; `TAG=release make push`
tags a release. The registry and project default to
`registry.leviathan.systems/logerhub` and are overridable:
`make push REGISTRY=… PROJECT=…`.

If you would rather build on the server anyway:

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

**On first start the gateway creates `admin` / `admin`** and says so in its logs.
Log in with it and the console serves nothing but a change-password screen until
you replace it — no page, no data, no API key.

That default is a real exposure for as long as it lasts: anyone who reaches the
console before you do can set the password themselves. So log in immediately
after the first `make deploy`, or set `BOOTSTRAP_ADMIN=off` in `.env` and create
the account by hand, below.

```bash
docker compose logs ingest | grep bootstrapped
```

### Creating accounts by hand

The operator password is read from stdin, never from the command line, so it
stays out of your shell history and out of `/proc` where any other process on
the host could read it. Note `exec -T`, which is what passes stdin through:

```bash
# Type it when prompted:
docker compose exec -e LOGGUBER_DB=/data/logguber.db ingest \
  node --experimental-strip-types apps/ingest/src/seed.ts operator you@example.com

# Or pipe it, if you are scripting (minimum 12 characters):
printf %s "$PASSWORD" | docker compose exec -T -e LOGGUBER_DB=/data/logguber.db ingest \
  node --experimental-strip-types apps/ingest/src/seed.ts operator you@example.com
```

Then one key per service. The environments are required — a key with no
environment scope may write any environment name, and each distinct name
becomes another Loki stream:

```bash
docker compose exec -T -e LOGGUBER_DB=/data/logguber.db ingest \
  node --experimental-strip-types apps/ingest/src/seed.ts key office-api office-api prod
```

Each key's secret prints once; only its hash is stored. Repeat per service, and
list them later with `… seed.ts list`.

Or create keys in the console, under **API Keys** — same minting, same scope
rules, and the secret is shown once there too. That does mean it passes through
a browser, which the CLI avoided; it is the same bargain GitHub and Stripe make,
and worth it so a key can be issued without shell access to the gateway.

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

### If the build stalls

The symptom is `pnpm install` sitting at `Progress: resolved 1, reused 0,
downloaded 0, added 0` for minutes. The build is waiting on the npm registry,
not working. Three causes, in the order they are worth checking:

```bash
# 1. Can a container reach the registry at all, and how fast?
docker run --rm node:24-alpine \
  sh -c 'time wget -qO- https://registry.npmjs.org/ws > /dev/null'

# 2. What does DNS answer with? An IPv6-only answer on a host with no IPv6
#    route is the usual cause: every connection waits for a timeout first.
docker run --rm node:24-alpine nslookup registry.npmjs.org

# 3. Is there a proxy the build needs to know about?
docker run --rm -e HTTP_PROXY -e HTTPS_PROXY node:24-alpine env | grep -i proxy
```

The Dockerfiles already pass `--dns-result-order=ipv4first`, which fixes the
IPv6 case, and keep the pnpm store on a build cache mount so a rebuild reuses
what it already downloaded. If a proxy is in play, pass it to the build:

```bash
docker compose build --build-arg HTTP_PROXY="$HTTP_PROXY" \
                     --build-arg HTTPS_PROXY="$HTTPS_PROXY"
```

Both services build at once, each installing its own dependencies, so a slow
link is hit twice in parallel. `docker compose build ingest` then
`docker compose build web` is slower overall but easier to watch.

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
# on your workstation
git pull && make push

# on the server
git pull && make deploy
```

The server still needs `git pull`: the compose file, Loki's config and the nginx
config are read from the checkout, not from the images.

Building on the server instead is `git pull && docker compose up -d --build`,
which needs ~2GB free for `next build` — it is killed by the OOM killer below
about 1.5GB, and the symptom is `failed to execute bake: signal: killed` right
after "Creating an optimized production build".

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

### Two package managers, on purpose

Development installs with **pnpm**; the Docker images install with **npm**, which
ships inside the node image and so needs nothing downloaded before the install
can start.

There is one source of truth for dependency *ranges*: workspace siblings are
declared as a plain `*`, because npm rejects `workspace:*` outright
(`EUNSUPPORTEDPROTOCOL`), and `linkWorkspacePackages: true` in
`pnpm-workspace.yaml` makes pnpm resolve `*` to the local package instead of
fetching it from the registry. The root manifest carries the `workspaces` field
npm needs; pnpm reads the yaml and ignores it.

Only the lockfiles differ, so **after changing any dependency, regenerate both**:

```bash
node scripts/relock.mjs     # then: pnpm test
```

`pnpm test` fails if the two disagree in a way that matters, so forgetting this
is caught rather than shipped. One divergence is expected and allowed: pnpm 11
holds back packages published in the last day or two as supply-chain protection
and npm has no equivalent, so npm sits a patch ahead on a few packages. What the
check refuses is npm resolving something **older** than the tests use, or more
than `COOLDOWN_ALLOWANCE` packages differing — both mean a manifest changed and
only one lockfile was regenerated.

That lag is the real cost of this split, and it points the wrong way: the images
can install a release pnpm is still holding back. `deploy/*.Dockerfile` carries
the same note.

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
