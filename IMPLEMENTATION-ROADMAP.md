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

## Phase 4.5 — Stabilization and Phase 5 Entry Integrity
Session/import/queue/audit/template/storage cleanup stabilization plus certificate integrity, exact generation planning and capability-minimized renderer contracts.

Status: Implemented on the stabilization branch. Entry to Phase 5 still requires the stabilization PR's full Quality Gate and Integration Gate to be green before merge/continuation.

## Phase 5 — Certificate Generation
Generation queue, workers, PDF, storage, QR.

Entry contract: read migrations 006/007 and ADR-016 through ADR-018 first. Phase 5 must materialize exact generation targets transactionally, render from immutable issuance snapshots/planned issue time, retain renderer revision, use durable queue/storage reconciliation, and call the strict `packages/certificate-renderer` boundary rather than giving rendering infrastructure capabilities.

Status: Implemented on 2026-08-25. Completion evidence covers the authenticated generation API through transactional planning, PostgreSQL outbox dispatch, BullMQ execution, immutable snapshot/template rendering, QR/PDF generation, private S3-compatible storage publication, integrity metadata, idempotent redelivery, multi-item retry/progress, terminal revocation protection and storage cleanup reconciliation. Public verification and download remain Phase 6.

## Phase 6 — Public Verification
Verification, stateless token, rate limiting, secure download.

Status: Implemented on 2026-08-26. Completion evidence covers stateless HS256 verification tokens with trusted-key rotation, current-state public verification, separately typed short-lived download authorization, bounded application-mediated private PDF redemption, byte-length/SHA-256/PDF-signature validation, final revocation/publication guards, distributed Redis rate limits, generic public failures and the fragment-based `/verify` browser flow. Phase 7 security testing and Phase 8 production deployment remain incomplete.

## Phase 7 — Security Testing
Threat-model tests, abuse testing, upload/PDF hardening.

## Phase 8 — Production Deployment
Observability, backups, deployment, restore drill, documentation.

## Rule

Do not move to the next phase while critical security or data-integrity tests are failing.
Do not renumber phases in downstream documents; this roadmap is canonical.
