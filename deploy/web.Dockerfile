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
COPY --from=build /app /app
ENV NODE_ENV=production
EXPOSE 3000
WORKDIR /app/apps/web
CMD ["npx", "next", "start", "-p", "3000"]
