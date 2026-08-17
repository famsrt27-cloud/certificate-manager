# 03 — Canonical Technology Stack

## Authority

This document is the canonical implementation baseline. The technologies below are approved and locked. Replacing one, introducing an overlapping framework, or changing the runtime architecture requires an ADR and explicit approval.

Phase 0B does not create application source, install packages or choose dependency versions. Exact compatible package versions must be pinned in the root `package.json` and `pnpm-lock.yaml` when Phase 1 scaffolding is authorized.

## Language and package management

| Concern | Locked decision |
|---|---|
| Application language | TypeScript across frontend, backend, worker and shared packages |
| JavaScript runtime | Node.js, as required by Next.js and Fastify; no alternative runtime is authorized |
| Package manager | pnpm with workspaces |
| Dependency lock | One root `pnpm-lock.yaml`, committed and used with frozen-lockfile mode in CI |
| Type safety | TypeScript strict mode; no unchecked cross-package contract duplication |

The exact supported Node.js and pnpm releases must be pinned during Phase 1 to versions supported by the selected package releases. Pinning compatible releases is not authorization to replace any locked technology.

## Phase 1 runtime pins

- Node.js `24.12.0` (the repository accepts compatible `24.x` releases from `24.12.0` onward)
- pnpm `11.5.2` with one root `pnpm-lock.yaml`
- TypeScript `6.0.3`
- PostgreSQL development image `postgres:16.12-alpine`
- Redis development image `redis:8.2.3-alpine`
- MinIO development image `minio/minio:RELEASE.2025-09-07T16-13-09Z`

Application and tool package versions are exact in `package.json` files and resolved by the root lockfile. ESLint remains on the compatible 9.x line because the React lint plugin used by the locked Next.js release is not compatible with ESLint 10.

## Frontend

| Concern | Locked decision |
|---|---|
| Framework | Next.js |
| Styling | Tailwind CSS |
| Validation/contract consumption | Shared Zod schemas where browser-safe |
| E2E testing | Playwright |

Rules:

- `apps/web` contains both the authenticated admin UI and minimal public verification UI.
- Next.js is the web layer, not a replacement for the canonical Fastify backend.
- Browser bundles may import only browser-safe shared contracts and utilities.
- Database, Redis, bcrypt, signing keys, S3 credentials and server-only packages must never enter client bundles.
- Public pages follow noindex, no-store and no-referrer requirements.

## Backend API

| Concern | Locked decision |
|---|---|
| HTTP framework | Fastify |
| Language | TypeScript |
| Request/response validation | Zod |
| Database access | Kysely |
| API testing | Vitest + Supertest |

Rules:

- `apps/api` is the sole canonical implementation of `/api/admin/*` and `/api/public/*`.
- Fastify route handlers remain thin and call application/domain services.
- Every external input is validated with the canonical Zod schema before reaching a service.
- API response mapping explicitly converts internal TypeScript names to the snake_case wire contract in `docs/10-api-contract.md`.
- Kysely queries are organization-scoped and do not replace database constraints.

## Database and migrations

| Concern | Locked decision |
|---|---|
| Database | PostgreSQL 16 |
| Query builder | Kysely |
| Migration tool | node-pg-migrate |

Rules:

- PostgreSQL 16 behavior is the schema baseline.
- `docs/09-postgresql-schema.sql` remains the approved reference schema until migrations are implemented.
- Phase 1 migrations are append-only and generated/maintained with node-pg-migrate.
- Kysely database types reflect the applied schema; they do not redefine it.
- No ORM or second query builder may be introduced alongside Kysely.
- Migrations must preserve composite tenant constraints, immutable-template triggers and append-only audit behavior.

## Authentication and security state

| Concern | Locked decision |
|---|---|
| Password hashing | bcrypt |
| Session storage | Redis-backed server-side sessions |
| Browser session transport | Secure HttpOnly cookie containing only an opaque session identifier |
| CSRF | Session-bound CSRF token validated on state-changing admin requests |

Rules:

- Do not replace server-side sessions with browser-stored JWT authorization.
- Redis stores session state with explicit idle and absolute expiry.
- Login, privilege change and sensitive authentication events rotate the session identifier as required by `docs/02-security-privacy.md`.
- Bcrypt input is validated by UTF-8 byte length before hashing so data beyond bcrypt's 72-byte input boundary is never silently ignored.
- Bcrypt work factor is configurable and calibrated to the deployment environment without weakening the approved minimum security baseline.

## Template, QR and PDF

| Concern | Locked decision |
|---|---|
| Template format | Custom versioned JSON definition |
| Template validation | Zod validator |
| Binding | Custom allowlisted data binder |
| PDF generation | PDFKit |
| QR generation | qrcode |

Rules:

- The template is data and cannot execute JavaScript.
- The binder resolves only documented fields and never evaluates expressions or object paths outside the allowlist.
- PDFKit receives validated coordinates, fonts, text, images and generated QR data only.
- Rendering is deterministic for the same certificate data, template version, asset set and renderer revision.
- Remote resource loading is prohibited; assets and fonts come from validated private/internal sources.

## Queue and workers

| Concern | Locked decision |
|---|---|
| Queue | BullMQ |
| Queue state/backend | Redis |
| Worker runtime | Separate TypeScript worker process |

Rules:

- `apps/worker` consumes participant-import and certificate-generation jobs.
- HTTP handlers enqueue bounded work and never perform bulk PDF generation inline.
- BullMQ retry settings complement, but do not replace, durable PostgreSQL job/item state and idempotency constraints.
- Queue payloads contain internal identifiers only, are versioned and are never exposed publicly.
- Dead-letter/operator recovery follows the canonical job states in the database contract.

## Object storage

| Concern | Locked decision |
|---|---|
| Storage protocol | S3-compatible object storage |
| Local/default compatible service | MinIO |
| Client | `@aws-sdk/client-s3` |

Rules:

- Buckets are private and environment-separated.
- Storage keys remain server-only.
- Upload, read and deletion operations go through the shared storage package.
- Public certificate download follows application-controlled authorize-and-stream behavior.
- MinIO is the Docker Compose development service; production may use an approved S3-compatible provider without changing the storage contract.

## Testing

| Concern | Locked decision |
|---|---|
| Unit/integration runner | Vitest |
| API integration | Supertest |
| Browser E2E | Playwright |

Testing layout and required suites are defined in `docs/07-testing-strategy.md`.

## Deployment

| Concern | Locked decision |
|---|---|
| Container orchestration baseline | Docker Compose |
| Required services | web, api, worker, postgres, redis, minio |

PostgreSQL, Redis and MinIO are private internal services. Deployment details follow `docs/20-deployment.md`.

## Explicitly out of baseline

Do not introduce a replacement or parallel implementation such as another web framework, backend framework, ORM/query builder, migration tool, queue, session model, PDF engine, template execution engine, validation library, test runner or container orchestrator without a new approved ADR.
