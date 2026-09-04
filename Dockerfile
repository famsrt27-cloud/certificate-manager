# syntax=docker/dockerfile:1.7
# Node and pnpm are deliberately pinned to the approved runtime contract. Never
# pass production secrets as build arguments: all runtime configuration is injected
# by Compose or the deployment environment.
FROM node:24.19.0-alpine AS workspace

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@11.5.2 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/certificate-renderer/package.json packages/certificate-renderer/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/template-engine/package.json packages/template-engine/package.json
RUN pnpm install --frozen-lockfile

COPY . .

FROM workspace AS build
ENV API_INTERNAL_BASE_URL=http://api:3001
RUN pnpm --filter @certificate-platform/web... build \
  && pnpm --filter @certificate-platform/api... build \
  && pnpm --filter @certificate-platform/worker... build

FROM build AS api-dependencies
RUN pnpm --filter @certificate-platform/api --prod deploy --legacy /runtime

FROM build AS web-dependencies
RUN pnpm --filter @certificate-platform/web --prod deploy --legacy /runtime

FROM build AS worker-dependencies
RUN pnpm --filter @certificate-platform/worker --prod deploy --legacy /runtime

FROM node:24.19.0-alpine AS runtime-base
RUN addgroup -S -g 10001 certificate \
  && adduser -S -D -H -u 10001 -G certificate certificate
USER certificate
WORKDIR /app

FROM runtime-base AS web
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
COPY --from=build --chown=certificate:certificate /workspace/apps/web/.next/standalone ./
COPY --from=build --chown=certificate:certificate /workspace/apps/web/.next/static ./apps/web/.next/static
COPY --from=web-dependencies --chown=certificate:certificate /runtime/node_modules ./node_modules
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

FROM runtime-base AS api
ENV NODE_ENV=production
COPY --from=api-dependencies --chown=certificate:certificate /runtime ./
COPY --from=build --chown=certificate:certificate /workspace/apps/api/dist ./dist
EXPOSE 3001
CMD ["node", "dist/server.js"]

FROM runtime-base AS worker
ENV NODE_ENV=production
COPY --from=worker-dependencies --chown=certificate:certificate /runtime ./
COPY --from=build --chown=certificate:certificate /workspace/apps/worker/dist ./dist
EXPOSE 3002
CMD ["node", "dist/server.js"]

# Migration execution is intentionally a distinct image target and command. It
# contains only the database migration runtime, not the API or worker service.
FROM workspace AS migrate
RUN addgroup -S -g 10001 certificate \
  && adduser -S -D -H -u 10001 -G certificate certificate \
  && pnpm --filter @certificate-platform/database deploy --legacy /runtime
WORKDIR /runtime
USER certificate
CMD ["node", "node_modules/node-pg-migrate/bin/node-pg-migrate.js", "--migrations-dir", "migrations", "--advisory-lock-mode", "fail", "up"]
