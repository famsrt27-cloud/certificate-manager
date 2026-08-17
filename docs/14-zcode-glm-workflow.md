# 14 — Staged Development Workflow

## Canonical phases

Phase numbering follows `IMPLEMENTATION-ROADMAP.md`. Do not combine, skip or renumber phases in prompts or implementation plans.

## Phase 0 — Architecture and Contract

Read:

- `AGENTS.md`
- `README.md`
- `CODEX-START-HERE.md`
- `IMPLEMENTATION-ROADMAP.md`
- `docs/00-project-overview.md`
- `docs/01-system-architecture.md`
- `docs/02-security-privacy.md`
- `docs/03-technology-stack.md`
- `docs/04-repository-layout-and-naming.md`
- `docs/05-database-design.md`
- `docs/07-testing-strategy.md`
- `docs/08-erd.md`
- `docs/09-postgresql-schema.sql`
- `docs/10-api-contract.md`
- `docs/24-adr.md`

Complete:

- specification consistency
- approved TypeScript/pnpm stack lock without selecting a replacement stack
- naming and source-of-truth ownership
- architecture, database, API, security and ADR approval

Do not create application source or migrations until Phase 0 is approved.

## Phase 1 — Foundation

Implement only the approved stack and structure:

- pnpm workspace with `apps/web`, `apps/api`, `apps/worker` and approved shared packages
- strict TypeScript configuration and Zod-validated environment configuration
- Next.js/Tailwind, Fastify and BullMQ process entrypoints
- PostgreSQL 16, Kysely and node-pg-migrate foundation
- Redis and MinIO Docker Compose services
- logging and redaction
- health checks
- Vitest, Supertest and Playwright harnesses

## Phase 2 — Authentication and RBAC

Read:

- `docs/02-security-privacy.md`
- `docs/05-database-design.md`
- `docs/18-roles-permissions.md`

Implement bcrypt authentication, Redis-backed opaque sessions, session-bound CSRF, organization memberships, backend RBAC and audit foundation. Include negative cross-tenant, session-fixation, CSRF and privilege-escalation tests.

## Phase 3 — Project, Training and Participant

Implement authorized project/training CRUD, participant management, Zod-validated private CSV/XLSX upload metadata, validation preview, confirmation and BullMQ import jobs.

Certificate generation must not begin before a confirmed import succeeds.

## Phase 4 — Template Builder

Read:

- `docs/12-template-engine.md`
- `docs/17-ui-specification.md`

Implement custom JSON/Zod templates, the allowlisted data binder, validated S3-compatible private assets, draft definitions, preview and atomic immutable publishing. Do not execute arbitrary template JavaScript.

## Phase 5 — Certificate Generation

Read:

- `docs/11-token-spec.md`
- `docs/13-pdf-generation.md`

Implement PostgreSQL-backed idempotent jobs/items, bounded BullMQ workers, deterministic PDFKit rendering, qrcode generation, S3-compatible storage through `@aws-sdk/client-s3` and integrity metadata.

## Phase 6 — Public Verification

Read:

- `docs/02-security-privacy.md`
- `docs/10-api-contract.md`
- `docs/11-token-spec.md`
- `docs/23-threat-model.md`

Implement Fastify public routes, signed token verification, public identifier resolution, certificate-state checks, Redis-backed distributed rate limiting, minimal responses and application-controlled secure download. Implement the public page in Next.js without creating a second backend.

## Phase 7 — Security Testing

Run and document:

- cross-tenant authorization and IDOR tests
- role and privilege-escalation tests
- token tampering/algorithm/rotation tests
- brute-force and rate-limit tests
- upload and parser abuse tests
- XSS, SSRF and path-traversal tests
- PDF sandbox and resource-exhaustion tests
- revocation-between-authorization-and-download tests
- secret and PII log-leak tests

## Phase 8 — Production Deployment

Complete Docker Compose deployment hardening, observability, alerts, key rotation, PostgreSQL/MinIO backup and restore drills, data retention and operational documentation.

## Change discipline

Before changing code or contracts:

- identify the active phase and governing documents
- list files to change and why
- state assumptions
- avoid unrelated refactoring
- add or amend an ADR for architecture/security/contract changes

After changes:

- run relevant tests, lint, typecheck and build
- run documentation/reference consistency checks when contracts changed
- summarize changed files
- report unresolved risks without weakening controls
