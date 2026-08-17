# 25 — Coding Agent Prompt Pack

## Prompt 1 — Repository analysis

Read `AGENTS.md` and the relevant files in `docs/`.
Do not modify code.
Return:
1. current architecture
2. missing components
3. risks
4. implementation order

Use `CODEX-START-HERE.md`, `IMPLEMENTATION-ROADMAP.md` and the Phase 0–8 numbering. Treat `docs/10-api-contract.md` as the API source of truth.
Treat `docs/03-technology-stack.md`, `docs/04-repository-layout-and-naming.md` and `docs/07-testing-strategy.md` as locked implementation constraints. Do not add replacement or parallel technologies.

## Prompt 2 — Database

Read:
- `01-system-architecture.md`
- `03-technology-stack.md`
- `04-repository-layout-and-naming.md`
- `05-database-design.md`
- `07-testing-strategy.md`
- `08-erd.md`
- `09-postgresql-schema.sql`
- `AGENTS.md`

Implement the Kysely/PostgreSQL 16 database layer and node-pg-migrate migrations in the approved pnpm workspace.
Do not add fields not specified by the documents.
Add tests for composite tenant constraints, role scope, public identifier immutability, template immutability, job idempotency and relationships.

## Prompt 3 — Auth/RBAC

Read:
- `02-security-privacy.md`
- `03-technology-stack.md`
- `18-roles-permissions.md`

Implement bcrypt authentication, Redis opaque sessions, session-bound CSRF and RBAC in Fastify.
Authorization must be enforced server-side.
Resolve organization access through membership and add negative tests for cross-tenant access and privilege escalation.

## Prompt 4 — Template engine

Read:
- `03-technology-stack.md`
- `12-template-engine.md`
- `17-ui-specification.md`

Implement custom JSON template definitions, Zod validation, allowlisted binding, versioning and preview.
Do not execute arbitrary template JavaScript.

## Prompt 5 — Certificate generation

Read:
- `03-technology-stack.md`
- `13-pdf-generation.md`

Implement BullMQ/Redis worker-based PDFKit generation, qrcode and S3-compatible storage through `@aws-sdk/client-s3`.
Make jobs idempotent and retryable.

## Prompt 6 — Verification

Read:
- `03-technology-stack.md`
- `11-token-spec.md`
- `10-api-contract.md`
- `23-threat-model.md`

Implement Fastify signed stateless token verification, PostgreSQL certificate-status lookup, Redis rate limiting and secure download authorization. Implement UI only in Next.js.

Never encode an internal UUID in a public token. Use the separate opaque public certificate identifier and implement both download authorization and POST redemption with a second status check.

## Prompt 7 — Security review

Do not change behavior.
Audit the implementation against `02-security-privacy.md` and `23-threat-model.md`.
List vulnerabilities by severity and propose patches.

## Prompt 8 — Test review

Run all tests and identify untested security-sensitive paths.
Use Vitest, Supertest and Playwright only. Add tests without weakening existing assertions.
