# Codex — Start Here

ไฟล์นี้เป็น canonical entry point ของ repository สำหรับ Coding Agent

## Read order

ก่อนแก้โค้ดให้อ่านตามลำดับ:

1. `AGENTS.md`
2. `README.md`
3. `CODEX-START-HERE.md`
4. `IMPLEMENTATION-ROADMAP.md`
5. `docs/00-project-overview.md`
6. `docs/01-system-architecture.md`
7. `docs/02-security-privacy.md`
8. `docs/03-technology-stack.md`
9. `docs/04-repository-layout-and-naming.md`
10. `docs/05-database-design.md`
11. `docs/07-testing-strategy.md`
12. `docs/08-erd.md`
13. `docs/10-api-contract.md`
14. `docs/11-token-spec.md`
15. `docs/12-template-engine.md`
16. `docs/13-pdf-generation.md`
17. `docs/24-adr.md`

จากนั้นอ่าน implementation/migrations/tests ของ Phase ที่กำลังทำ

## Current repository checkpoint

- Phases 1–4 are implemented.
- Phase 4.5 stabilization/integrity work establishes the entry contract for Phase 5.
- Phase 5 certificate generation is implemented, including durable planning/outbox delivery, BullMQ processing, immutable snapshot rendering, QR/PDF generation, private storage publication, integrity metadata, retry/dead-letter behavior and storage reconciliation.
- `docs/09-postgresql-schema.sql` and `packages/database/schema/0001-canonical-schema.sql` are frozen migration-0001 snapshots. Do not edit them to represent later schema changes; use append-only migrations.
- Read migrations `202608240006_certificate-integrity-foundation.ts` and `202608240007_certificate-generation-contract.ts` before implementing certificate generation.
- Read ADR-016, ADR-017 and ADR-018 before touching certificate lifecycle, job planning, regeneration, reissue, verification URL or renderer code.

## Phase 5 entry invariants

Do not implement Phase 5 in a way that violates these rules:

- certificate identity and issuance snapshot are immutable
- planned issue time comes from the immutable snapshot
- revoked certificates never become available again
- only one non-revoked certificate exists per training participant
- initial generation does not silently reissue certificate history
- generation idempotency binds to the exact first-resolved participant set
- an ALL_ELIGIBLE retry never re-resolves a later population
- renderer revision is immutable per generation job
- stale generation revisions cannot overwrite a newer PDF/revision
- `packages/certificate-renderer` is capability-minimized and receives no DB/S3/Redis/signing/network capability
- renderer receives a prepared verification URL only; it never signs tokens

## Change rule

Work only on the approved phase and locked TypeScript/pnpm stack. Do not change technology, architecture, security controls, database contracts, API contracts or the invariants above without updating the governing documents, tests and ADRs in the same change.
