FROM node:24-alpine
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/ingest/package.json apps/ingest/
RUN pnpm install --frozen-lockfile --filter @logguber/ingest...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/ingest apps/ingest

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "apps/ingest/src/server.ts"]
