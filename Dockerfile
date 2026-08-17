# syntax=docker/dockerfile:1.7
FROM node:24.12.0-alpine AS workspace

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
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/queue/package.json packages/queue/package.json
RUN pnpm install --frozen-lockfile

COPY . .

FROM workspace AS web
ENV API_INTERNAL_BASE_URL=http://api:3001
RUN pnpm --filter @certificate-platform/web... build
EXPOSE 3000
CMD ["pnpm", "--filter", "@certificate-platform/web", "start"]

FROM workspace AS api
RUN pnpm --filter @certificate-platform/api... build
EXPOSE 3001
CMD ["node", "apps/api/dist/server.js"]

FROM workspace AS worker
RUN pnpm --filter @certificate-platform/worker... build
EXPOSE 3002
CMD ["node", "apps/worker/dist/server.js"]

FROM workspace AS migrate
CMD ["pnpm", "--filter", "@certificate-platform/database", "migrate"]
