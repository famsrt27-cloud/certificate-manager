# Implementation Roadmap

## Phase 0 — Architecture and Contract
1. Review and repair specifications.
2. Lock the approved implementation stack in `docs/03-technology-stack.md`; do not select or introduce a replacement stack.
3. Lock pnpm workspace layout and naming conventions in `docs/04-repository-layout-and-naming.md`.
4. Approve ADRs, ERD, database schema and API contract.
5. Lock the Vitest/Supertest/Playwright strategy in `docs/07-testing-strategy.md`.
6. Complete a repository-wide consistency review.

## Phase 1 — Foundation
Create the approved pnpm workspace and TypeScript configuration; scaffold Next.js web, Fastify API and worker boundaries; add PostgreSQL 16/node-pg-migrate/Kysely foundation, validated configuration, logging, Docker Compose infrastructure, health checks and test harness.

Status: Implemented on 2026-08-18. This status records foundation scaffolding only; Phase 2 authorization and status are recorded separately below.

## Phase 2 — Authentication and RBAC
Admin authentication, sessions, tenant membership, RBAC and audit foundation.

Status: Implemented on 2026-08-18 for non-production environments. Production startup remains intentionally blocked until an MFA schema/API contract and implementation are approved; this is a security gate, not authorization to begin Phase 3.

## Phase 3 — Project, Training and Participant
Authorized CRUD, participant import, validation, preview and import jobs.

Status: Implemented on 2026-08-18. The Phase 2 production MFA startup gate remains in force; Phase 4 status is recorded separately below.

## Phase 4 — Template Builder
Builder, validated assets, versions, preview and immutable publish.

Status: Implemented on 2026-08-18 for template management only. This phase intentionally excludes PDF generation, certificate issuance and all Phase 5 work. PostgreSQL integration execution remains environment-gated on a provisioned `TEST_DATABASE_URL`.

## Phase 5 — Certificate Generation
Generation queue, workers, PDF, storage, QR.

## Phase 6 — Public Verification
Verification, stateless token, rate limiting, secure download.

## Phase 7 — Security Testing
Threat-model tests, abuse testing, upload/PDF hardening.

## Phase 8 — Production Deployment
Observability, backups, deployment, restore drill, documentation.

## Rule

Do not move to the next phase while critical security or data-integrity tests are failing.
Do not renumber phases in downstream documents; this roadmap is canonical.
