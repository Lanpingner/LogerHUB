# Built with npm, not pnpm: npm ships inside the node image, so nothing is
# downloaded before the install can start. Development uses pnpm; the two agree
# because the manifests use a plain `*` for workspace siblings (npm cannot parse
# `workspace:*`, and `linkWorkspacePackages` in pnpm-workspace.yaml makes pnpm
# resolve `*` to the local package). `pnpm test` includes a check that the two
# lockfiles still resolve every shared dependency to the same version.
FROM node:24-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/client/package.json packages/client/
COPY apps/ingest/package.json apps/ingest/
COPY apps/web/package.json apps/web/
# `--dns-result-order=ipv4first`: registry.npmjs.org answers with AAAA records, and
# a Docker network without an IPv6 route stalls on each one until it times out —
# which looks exactly like a hung install. The retries turn a lossy network into a
# slow build rather than a failed one.
# The npm cache is a BuildKit cache mount, so a rebuild reuses what it has.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    NODE_OPTIONS=--dns-result-order=ipv4first \
    npm ci --omit=dev --ignore-scripts \
      --fetch-retries=5 --fetch-timeout=300000 \
      --workspace @logguber/ingest --include-workspace-root

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/ingest apps/ingest

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "apps/ingest/src/server.ts"]
