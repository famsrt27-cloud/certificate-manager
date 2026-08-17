# Certificate Platform — Professional Specification v3.0

เอกสารชุดนี้เป็นฐานสำหรับพัฒนา Certificate Management & Public Verification Platform

## Key architecture decision

Verification Token **ไม่เก็บใน Database** โดยใช้ signed stateless token

แต่ Certificate Status ยังเก็บใน Database เพื่อรองรับ:
- Active
- Revoked
- Archived

ดังนั้นระบบเป็น:
**Stateless Verification Secret + Stateful Certificate Status**

## Canonical implementation baseline

- TypeScript full stack managed as pnpm workspaces
- Next.js + Tailwind CSS web
- Fastify API with Zod validation
- PostgreSQL 16 with Kysely and node-pg-migrate
- bcrypt + Redis server-side sessions + CSRF
- BullMQ + Redis workers
- Custom JSON/Zod template engine with PDFKit + qrcode rendering
- S3-compatible private storage through `@aws-sdk/client-s3`, with MinIO for Docker Compose development
- Vitest + Supertest + Playwright testing
- Docker Compose deployment baseline

Do not replace or duplicate this stack without an approved ADR.

## Phase 2 authentication and RBAC

Phase 2 adds bcrypt password handling with the 72-byte UTF-8 guard, Redis opaque sessions, hardened host-only cookies, idle/absolute expiry, session-bound CSRF, distributed login throttling, PostgreSQL-resolved memberships/RBAC, tenant authorization policy and append-only authentication/authorization audit events. Project, training and participant CRUD, templates, PDF generation and public verification remain intentionally absent.

From the repository root:

```powershell
Copy-Item .env.example .env
pnpm install --frozen-lockfile
pnpm test
pnpm test:security
pnpm lint
pnpm typecheck
pnpm build
pnpm compose:config
pnpm db:migrate
```

For real infrastructure integration tests, start PostgreSQL and Redis, apply migrations, then set `TEST_DATABASE_URL` and `TEST_REDIS_URL` before `pnpm test:integration`. Production API startup is intentionally blocked until the canonical contract is extended with approved MFA support.

Use `docker compose up -d postgres redis minio` for local infrastructure, then start the applications with `pnpm dev`. API health is available at `/health/live` and `/health/ready`; the worker exposes the same paths on its internal Compose health port (or loopback when started directly for local development).

## Document map

- CODEX-START-HERE.md — canonical entry point
- AGENTS.md — กฎสำหรับ AI Coding Agent
- CLAUDE.md — compatibility instruction สำหรับ Claude Code
- docs/01-system-architecture.md — system boundaries and data flow
- docs/02-security-privacy.md — security and privacy controls
- docs/03-technology-stack.md — canonical implementation stack
- docs/04-repository-layout-and-naming.md — pnpm workspace layout and naming rules
- docs/05-database-design.md — database integrity rules
- docs/07-testing-strategy.md — canonical test layers and tools
- docs/08-erd.md — ERD
- docs/09-postgresql-schema.sql — PostgreSQL schema
- docs/10-api-contract.md — canonical API contract and source of truth
- docs/11-token-spec.md — Verification Token
- docs/12-template-engine.md — Template Builder/Engine
- docs/13-pdf-generation.md — PDF architecture
- docs/14-zcode-glm-workflow.md — วิธีให้ ZCode + GLM ทำงานเป็นขั้น
- docs/15-mvp-checklist.md — MVP checklist

## Important

เริ่มอ่านจาก `CODEX-START-HERE.md` และอย่าให้ AI สร้างระบบทั้งหมดในครั้งเดียว ให้ทำตาม workflow ใน `docs/14-zcode-glm-workflow.md`
