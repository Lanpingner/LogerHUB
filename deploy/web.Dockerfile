# The pnpm store lives on a BuildKit cache mount, so a rebuild reuses packages
# already downloaded instead of fetching them again. `--prefer-offline` then asks
# the registry only for what the store does not already have, which is what keeps
# a rebuild working on a slow, throttled or IPv6-stalled network.
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
# `--dns-result-order=ipv4first`: registry.npmjs.org answers with AAAA records, and
# a Docker network without an IPv6 route stalls on each one until it times out —
# which looks exactly like a hung install ("resolved 1, reused 0" for minutes).
# The retry and timeout settings turn a slow or lossy network into a slow build
# rather than a failed one.
RUN --mount=type=cache,target=/pnpm/store,sharing=locked \
    NODE_OPTIONS=--dns-result-order=ipv4first \
    npm_config_fetch_retries=5 \
    npm_config_fetch_retry_maxtimeout=120000 \
    npm_config_fetch_timeout=300000 \
    pnpm install --frozen-lockfile --prefer-offline \
      --store-dir=/pnpm/store --filter @logguber/web...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @logguber/web build

FROM node:24-alpine
RUN corepack enable
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production
EXPOSE 3000
WORKDIR /app/apps/web
CMD ["npx", "next", "start", "-p", "3000"]
