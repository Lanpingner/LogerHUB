# Built with npm, not pnpm — see deploy/ingest.Dockerfile for why.
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/client/package.json packages/client/
COPY apps/ingest/package.json apps/ingest/
COPY apps/web/package.json apps/web/
# Dev dependencies are needed here: next build runs from them.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    NODE_OPTIONS=--dns-result-order=ipv4first \
    npm ci --ignore-scripts \
      --fetch-retries=5 --fetch-timeout=300000 \
      --workspace @logguber/web --include-workspace-root

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build --workspace @logguber/web

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

# `output: 'standalone'` in next.config.mjs leaves a server carrying only the
# dependencies Next traced as reachable, which is what gets copied here. The
# alternative is `COPY --from=build /app /app`, which is what this used to do:
# it works, but ships the whole install — TypeScript, the build toolchain,
# every @types package — and the monorepo source, for an 840MB image against
# this one's 214MB. That matters because the workstation pushes and the
# server pulls, so the difference crosses the network on every deploy.
COPY --from=build /app/apps/web/.next/standalone ./
# Static assets are deliberately not part of the standalone output; they have
# to be placed beside the server or every /_next/static request 404s.
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static

# The server reads both. HOSTNAME must be set explicitly: Docker sets it to the
# container id, and the server would bind to that instead of every interface.
ENV PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
