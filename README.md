# Certificate Manager / Certificate Platform

> **Certificate Management & Public Verification Platform**  
> สถานะปัจจุบัน: **Phase 4.5 — Stabilization & Integrity Gate**  
> Branch ที่ใช้พัฒนาต่อ: `fix/phase-4-5-stabilization`  
> Base branch: `main`  
> Production readiness: **NO-GO จนกว่า Phase 4.5, MFA production gate, Phase 5–8 และ final security verification จะเสร็จ**

README นี้เป็นเอกสารหลักสำหรับ **ติดตั้งโปรเจกต์ใหม่, ย้ายเครื่อง, ตั้งค่า development environment, รัน infrastructure, migration, tests, CI และทำความเข้าใจ architecture / current project status** โดยไม่ต้องย้อนหา context จากแชตเดิม

---

## สารบัญ

1. [ระบบนี้คืออะไร](#1-ระบบนี้คืออะไร)
2. [สิ่งที่ระบบทำได้แล้ว / ยังไม่ได้ทำ](#2-สิ่งที่ระบบทำได้แล้ว--ยังไม่ได้ทำ)
3. [Architecture หลัก](#3-architecture-หลัก)
4. [Security และ Data Integrity Principles](#4-security-และ-data-integrity-principles)
5. [Technology Stack](#5-technology-stack)
6. [Repository Layout](#6-repository-layout)
7. [Current Development Checkpoint](#7-current-development-checkpoint)
8. [ย้ายเครื่อง: Checklist ก่อนออกจากเครื่องเก่า](#8-ย้ายเครื่อง-checklist-ก่อนออกจากเครื่องเก่า)
9. [ติดตั้งบนเครื่องใหม่ Windows](#9-ติดตั้งบนเครื่องใหม่-windows)
10. [Environment Variables](#10-environment-variables)
11. [Docker Infrastructure](#11-docker-infrastructure)
12. [Database และ Migrations](#12-database-และ-migrations)
13. [การรัน Development](#13-การรัน-development)
14. [Health Checks และ Service URLs](#14-health-checks-และ-service-urls)
15. [Testing](#15-testing)
16. [GitHub Actions / CI / Branch Protection](#16-github-actions--ci--branch-protection)
17. [ระบบ Authentication / Session / RBAC](#17-ระบบ-authentication--session--rbac)
18. [Project / Training / Participant Flow](#18-project--training--participant-flow)
19. [Participant Import / Queue Durability](#19-participant-import--queue-durability)
20. [Template / Asset / Version Flow](#20-template--asset--version-flow)
21. [Object Storage Consistency](#21-object-storage-consistency)
22. [Public Verification Architecture](#22-public-verification-architecture)
23. [Production Safety Gates](#23-production-safety-gates)
24. [Troubleshooting](#24-troubleshooting)
25. [Backup / Restore สำหรับย้ายเครื่อง](#25-backup--restore-สำหรับย้ายเครื่อง)
26. [Development Workflow](#26-development-workflow)
27. [Next Work](#27-next-work)
28. [Document Map](#28-document-map)
29. [Quick Command Reference](#29-quick-command-reference)

---

# 1. ระบบนี้คืออะไร

Certificate Manager เป็นระบบบริหารจัดการใบประกาศนียบัตรแบบ multi-tenant สำหรับองค์กร/โครงการอบรม โดย architecture ตั้งใจรองรับ workflow ตั้งแต่:

- จัดการองค์กรและสิทธิ์ผู้ดูแล
- จัดการโครงการ (`Project`)
- จัดการหลักสูตร/กิจกรรมอบรม (`Training`)
- จัดการผู้เข้าร่วม (`Participant`)
- Import รายชื่อจาก CSV / XLSX แบบ asynchronous
- สร้างและ versioning template ใบประกาศ
- Upload image/font asset แบบ private
- Publish template แบบ immutable
- สร้าง PDF certificate ใน worker
- เก็บ PDF ใน S3-compatible private object storage
- สร้าง QR / verification token
- ให้บุคคลภายนอกตรวจสอบ certificate โดย **ไม่ต้อง login**
- รองรับ revoke/archive certificate
- เก็บ audit log และ verification/download events

อย่างไรก็ตาม **ตอนนี้ implementation ยังไม่ถึง Phase 5** ดังนั้น actual certificate PDF generation และ public verification endpoint ยังไม่ใช่ production feature ที่เสร็จแล้ว

---

# 2. สิ่งที่ระบบทำได้แล้ว / ยังไม่ได้ทำ

## Implemented

### Phase 1 — Foundation

- pnpm monorepo/workspaces
- TypeScript full stack
- Next.js web boundary
- Fastify API boundary
- Worker boundary
- PostgreSQL 16
- Kysely
- node-pg-migrate
- Redis
- Docker Compose
- health endpoints
- testing foundation

### Phase 2 — Authentication & RBAC

- bcrypt password hashing
- Redis server-side sessions
- hardened session cookie
- CSRF validation
- organization membership
- tenant-scoped RBAC
- audit foundation
- login rate limiting
- authorization versioning
- safe session rotation/revocation behavior

> Production authentication ยังมี **MFA gate** และ production startup ต้องไม่ถูกเปิดผ่านโดยการลด security requirement

### Phase 3 — Project / Training / Participant

- project CRUD
- training CRUD
- participant management
- tenant isolation
- CSV/XLSX import upload
- import validation
- import preview
- BullMQ confirmation worker
- idempotent import requests
- PostgreSQL durable queue outbox
- retry/reconciliation logic

### Phase 4 — Template Management

- certificate template CRUD
- validated image/font assets
- private S3/MinIO storage
- custom JSON/Zod template definition
- template versions
- preview/data binding
- immutable publish
- PostgreSQL integrity triggers
- race-safe asset validation/locking
- transactional mutations + audit

### Phase 4.5 — Stabilization

Completed work up to the current checkpoint includes:

- Group 1 — session revocation/rotation integrity
- Group 2 — participant import idempotency
- Group 3 — queue durability/reconciliation
- Group 4 — transactional mutation + audit integrity
- Group 5A — template relational consistency / ghost draft / publish-archive race
- Group 5B — durable object-storage cleanup reconciliation

At the Group 5B checkpoint the verified runtime test results were:

```text
Phase 4 integration       8 / 8 passed
Storage cleanup           2 / 2 passed
Security suite           57 / 57 passed
Full integration         27 / 27 passed across 9 files
```

Test counts are a historical checkpoint and may increase as development continues.

## Not implemented / not production ready

- Phase 5 certificate generation
- real PDF issuance workflow
- final PDF rendering isolation
- public verification API/UI
- public certificate download
- final signed verification-token flow in code
- production MFA
- final production security hardening
- complete observability
- backup/restore operational drills
- final Docker/workspace cleanup
- production deployment

**Do not interpret existing schema/specification for these future phases as proof that those features are already implemented.**

---

# 3. Architecture หลัก

```mermaid
flowchart LR
    Browser[Admin Browser] --> Web[Next.js Web]
    Web --> API[Fastify API]

    API --> PG[(PostgreSQL 16)]
    API --> Redis[(Redis)]
    API --> S3[(S3 / MinIO Private Storage)]

    API -->|transactional queue intent| PG
    Worker[Worker] --> PG
    Worker --> Redis
    Worker --> BullMQ[BullMQ]
    BullMQ --> Redis
    Worker --> S3

    Public[Future Public Verification Client] -. Phase 6 .-> API
```

## Source-of-truth responsibilities

### PostgreSQL

PostgreSQL เป็น authoritative source สำหรับ:

- organizations
- memberships / roles
- projects
- trainings
- participants
- import jobs + rows
- template metadata
- template versions
- template asset metadata
- queue outbox
- storage cleanup outbox
- future certificate lifecycle/status
- audit/event records

### Redis

Redis ใช้สำหรับ:

- server-side sessions
- rate limiting
- BullMQ transport/state

Redis **ไม่ใช่ authoritative business database**

### S3 / MinIO

Object storage ใช้สำหรับ private binary objects เช่น:

- participant import source files
- template image/font assets
- future PDF certificate files

Object storage key ไม่ควรถูกเปิดเป็น public identifier

---

# 4. Security และ Data Integrity Principles

โปรเจกต์นี้ใช้แนวทาง **security first / privacy by design**

หลักที่ห้ามทำลาย:

1. public certificate verification ต้องไม่ใช้ sequential database IDs เป็น public secret
2. public verification ไม่ควรบังคับ recipient login
3. certificate status ต้องตรวจจาก PostgreSQL แม้ verification secret จะเป็น stateless
4. tenant scope ต้อง enforce ทุก operation
5. admin state-changing requests ต้องผ่าน session + CSRF + authorization
6. uploaded content ต้อง validate จริง ไม่เชื่อ filename/MIME จาก client
7. template renderer ต้องถือ input เป็น untrusted
8. published rendering inputs ต้อง immutable
9. relational mutation และ audit ที่อยู่ PostgreSQL เดียวกันต้อง atomic
10. queue intent ต้อง durable ก่อนส่งเข้า Redis/BullMQ
11. storage failure ต้องไม่ถูกกลืนจนเกิด orphan object โดยไม่มี recovery path
12. ห้าม commit secrets หรือ `.env`
13. ห้ามลด production MFA/security gates เพื่อให้ deployment ผ่านเร็วขึ้น

## Verification model

Canonical design คือ:

```text
Stateless signed verification secret
+
Opaque public certificate identifier
+
Stateful certificate status in PostgreSQL
```

หมายความว่า verification token ไม่จำเป็นต้องเก็บ secret ตัวเดียวกันลงฐานข้อมูล แต่การตรวจ certificate ยังต้อง query database เพื่อรู้ว่า certificate:

- valid
- revoked
- archived
- unavailable

แนวคิด public lookup ด้วย student code แบบเดิม **ไม่ใช่ canonical public verification design**

---

# 5. Technology Stack

| Layer | Technology |
|---|---|
| Language | TypeScript |
| Runtime | Node.js 24.x |
| Package Manager | pnpm 11.5.2 |
| Frontend | Next.js + Tailwind CSS |
| Backend | Fastify |
| Database | PostgreSQL 16 |
| Query Builder | Kysely |
| Migration | node-pg-migrate |
| Validation | Zod |
| Authentication | bcrypt + Redis server-side session + CSRF |
| Queue | BullMQ + Redis |
| Storage | S3-compatible + MinIO + `@aws-sdk/client-s3` |
| Template | Custom JSON + Zod + allowlisted data binder |
| Future PDF | PDFKit + qrcode |
| Unit/Integration | Vitest + Supertest |
| E2E | Playwright |
| Local/Deployment baseline | Docker Compose |

## Version requirements

Root `package.json` requires:

```text
Node: >=24.12.0 <25
pnpm: >=11.5.2 <12
```

CI currently uses:

```text
Node 24.19.0
pnpm 11.5.2
```

**Recommended on a new machine: use Node 24.19.0 to match CI.**

`.nvmrc` may still point at the minimum baseline version; the `package.json` engine range and CI are the more useful compatibility references when reproducing the current CI environment.

---

# 6. Repository Layout

```text
certificate-manager/
│
├─ apps/
│  ├─ web/                 Next.js admin web application
│  ├─ api/                 Fastify API
│  └─ worker/              background worker / queue / cleanup
│
├─ packages/
│  ├─ auth/                password/session/rate-limit primitives
│  ├─ config/              typed environment/config loaders
│  ├─ contracts/           shared API/domain contracts
│  ├─ database/            Kysely types, repositories, migrations
│  ├─ domain/              authorization/domain policies
│  ├─ queue/               BullMQ/Redis queue integration
│  ├─ storage/             private S3-compatible storage
│  └─ template-engine/     template schema + binder
│
├─ tests/
│  └─ security/            cross-cutting security tests
│
├─ docs/                   specification / architecture docs
├─ .github/workflows/      CI
├─ compose.yaml            Docker Compose topology
├─ Dockerfile              multi-stage app images
├─ .env.example            safe development config template
├─ package.json            root scripts + versions
├─ pnpm-workspace.yaml     workspace config
├─ IMPLEMENTATION-ROADMAP.md
├─ AGENTS.md
├─ CLAUDE.md
├─ CODEX-START-HERE.md
└─ README.md
```

---

# 7. Current Development Checkpoint

## Active development branch

```text
fix/phase-4-5-stabilization
```

PR:

```text
PR #1
base: main
state: Draft
```

**Do not merge PR #1 yet.**

Phase 4.5 ต้องเสร็จทุก group และ final verification ก่อน merge

## Main branch protection

`main` ถูกตั้ง ruleset ให้มี required checks:

```text
Quality Gate
Integration Gate
```

และควรคง policy:

- merge ผ่าน PR
- required checks must pass
- branch up to date before merge
- no force push
- no branch deletion
- ไม่บังคับ reviewer approval ถ้ายังเป็น repository ที่มี developer คนเดียว

## Resume point

หลัง Group 5B งานถัดไปคือ:

```text
Group 6 — Participant Import Cleanup Reliability
```

ยัง **ไม่เริ่ม Phase 5**

---

# 8. ย้ายเครื่อง: Checklist ก่อนออกจากเครื่องเก่า

ส่วนนี้สำคัญที่สุดถ้ากำลังเปลี่ยนคอมพิวเตอร์

## 8.1 ตรวจว่า Group 5B อยู่ใน Git จริง

หลัง Group 5B ควรมีไฟล์อย่างน้อย:

```text
packages/database/migrations/202608210004_storage-cleanup-outbox.ts
packages/database/src/storage-cleanup-repository.ts
apps/worker/src/storage-cleanup-reconciler.ts
apps/worker/tests/integration/storage-cleanup.integration.test.ts
```

ตรวจ:

```powershell
Test-Path packages/database/migrations/202608210004_storage-cleanup-outbox.ts
Test-Path packages/database/src/storage-cleanup-repository.ts
Test-Path apps/worker/src/storage-cleanup-reconciler.ts
```

ควรได้:

```text
True
True
True
```

## 8.2 ตรวจ working tree

```powershell
git status --short
git diff --stat
```

อย่าออกจากเครื่องเก่าจนรู้ว่ามีไฟล์อะไรยังไม่ได้ commit

## 8.3 Final local gates ก่อน checkpoint

Group 5B runtime tests ผ่านแล้ว แต่ก่อน commit/push ควรรัน static/build gate ด้วย:

```powershell
pnpm build
pnpm typecheck
pnpm test:security
pnpm test:integration
git diff --check
```

Expected checkpoint:

```text
Security:    57/57
Integration: 27/27
```

## 8.4 Commit Group 5B

ถ้ายังไม่ได้ commit ให้ stage เฉพาะ Group 5B:

```powershell
git add packages/database/migrations/202608210004_storage-cleanup-outbox.ts
git add packages/database/src/storage-cleanup-repository.ts
git add packages/database/src/types.ts
git add packages/database/src/index.ts
git add apps/api/src/modules/phase-four/phase-four-service.ts
git add apps/api/tests/integration/phase-four.integration.test.ts
git add apps/worker/src/storage-cleanup-reconciler.ts
git add apps/worker/src/server.ts
git add apps/worker/tests/integration/storage-cleanup.integration.test.ts

git diff --cached --check
git diff --cached --stat

git commit -m "fix(storage): add durable object cleanup reconciliation"
```

## 8.5 Commit README

หลังวาง README ฉบับนี้ไว้ที่ root:

```powershell
git add README.md
git diff --cached --check
git commit -m "docs: expand setup and project handoff guide"
```

## 8.6 Push ก่อนย้ายเครื่อง

```powershell
git push
```

จากนั้น:

```powershell
git status
git log --oneline -8
```

ควรเห็น:

```text
nothing to commit, working tree clean
```

และตรวจ GitHub Actions ให้ `Quality Gate` + `Integration Gate` ผ่าน

### สำคัญ

**Git commit อย่างเดียวไม่พอสำหรับการย้ายเครื่อง**

ถ้า commit อยู่เฉพาะเครื่องเก่าแต่ยังไม่ได้ `git push` เครื่องใหม่จะ clone ไม่เห็น commit นั้น

---

# 9. ติดตั้งบนเครื่องใหม่ Windows

## 9.1 Software ที่ควรมี

ติดตั้ง:

- Git
- Node.js 24.19.0
- Docker Desktop
- VS Code หรือ editor ที่ต้องการ

ตรวจ:

```powershell
git --version
node --version
docker --version
docker compose version
```

Node ควรประมาณ:

```text
v24.19.0
```

## 9.2 pnpm ผ่าน Corepack

```powershell
corepack enable
corepack prepare pnpm@11.5.2 --activate
pnpm --version
```

Expected:

```text
11.5.2
```

## 9.3 Clone repository

```powershell
git clone https://github.com/famsrt27-cloud/certificate-manager.git
cd certificate-manager
```

ดึง refs:

```powershell
git fetch --all --prune
```

ไป branch ที่กำลังพัฒนา:

```powershell
git switch fix/phase-4-5-stabilization
git pull --ff-only
```

ตรวจ:

```powershell
git branch --show-current
git status
git log --oneline -8
```

ต้องอยู่:

```text
fix/phase-4-5-stabilization
```

## 9.4 ตรวจว่าดึง Group 5B มาครบ

```powershell
Test-Path packages/database/migrations/202608210004_storage-cleanup-outbox.ts
Test-Path apps/worker/src/storage-cleanup-reconciler.ts
```

ถ้าได้ `False` แสดงว่า checkpoint จากเครื่องเก่ายังไม่ได้ถูก push ขึ้น remote

อย่าเริ่ม Group 6 จนกว่าจะกู้ checkpoint นี้กลับมาก่อน

## 9.5 Install dependencies

```powershell
pnpm install --frozen-lockfile
```

`--frozen-lockfile` สำคัญ เพราะต้องการให้ dependency graph ตรงกับ `pnpm-lock.yaml` และ CI

## 9.6 Clean-machine validation

บน fresh clone ให้ใช้ลำดับเดียวกับ CI:

```powershell
pnpm lint
pnpm build
pnpm typecheck
pnpm test:security
```

เหตุผลที่ **build มาก่อน typecheck**:

บาง workspace packages export TypeScript declarations จาก `dist/` ดังนั้น clean machine อาจยังไม่มี generated declarations ถ้ารัน typecheck ก่อน build

---

# 10. Environment Variables

สร้าง local environment file:

```powershell
Copy-Item .env.example .env
```

`.env` ถูก ignore โดย Git

ตรวจได้จาก `.gitignore` และ **ห้าม commit `.env`**

## 10.1 Generate SESSION_SECRET

อย่าใช้ placeholder เดิมนอก disposable local environment

สร้าง secret:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

เอาค่าที่ได้ใส่:

```env
SESSION_SECRET=<generated-value>
```

## 10.2 Core variables

### Runtime

| Variable | Default/Example | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | runtime mode |
| `LOG_LEVEL` | `info` | application logging |

### PostgreSQL

| Variable | Example | Purpose |
|---|---|---|
| `POSTGRES_DB` | `certificate_platform` | Docker PostgreSQL database |
| `POSTGRES_USER` | `certificate_app` | DB user |
| `POSTGRES_PASSWORD` | local placeholder | DB password |
| `POSTGRES_PORT` | `5432` | host-mapped port |
| `DATABASE_URL` | PostgreSQL URL | app DB connection |
| `DATABASE_MAX_CONNECTIONS` | `10` | pool max |

Default:

```env
POSTGRES_DB=certificate_platform
POSTGRES_USER=certificate_app
POSTGRES_PASSWORD=local-postgres-change-me
POSTGRES_PORT=5432
DATABASE_URL=postgresql://certificate_app:local-postgres-change-me@127.0.0.1:5432/certificate_platform
DATABASE_MAX_CONNECTIONS=10
```

### Redis

| Variable | Example | Purpose |
|---|---|---|
| `REDIS_PASSWORD` | local placeholder | Redis auth |
| `REDIS_PORT` | `6379` | host port |
| `REDIS_URL` | authenticated Redis URL | sessions/BullMQ |

```env
REDIS_PASSWORD=local-redis-change-me
REDIS_PORT=6379
REDIS_URL=redis://:local-redis-change-me@127.0.0.1:6379/0
```

### Authentication / Session

```env
SESSION_SECRET=<32+ byte high entropy secret>
SESSION_IDLE_TTL_SECONDS=1800
SESSION_ABSOLUTE_TTL_SECONDS=28800
BCRYPT_COST=12
LOGIN_RATE_LIMIT_WINDOW_SECONDS=900
LOGIN_RATE_LIMIT_ACCOUNT_MAX=5
LOGIN_RATE_LIMIT_NETWORK_MAX=20
ADMIN_ALLOWED_ORIGINS=http://localhost:3000
ADMIN_MFA_POLICY=DEFERRED_NON_PRODUCTION
```

ความหมาย:

- idle TTL = 30 นาที
- absolute TTL = 8 ชั่วโมง
- bcrypt cost = 12
- account login attempts = 5 ต่อ window
- network login attempts = 20 ต่อ window

### MFA

```env
ADMIN_MFA_POLICY=DEFERRED_NON_PRODUCTION
```

ค่านี้เป็น development/non-production policy

**อย่าเปลี่ยน production behavior เพื่อ bypass MFA gate**

### MinIO / S3

```env
MINIO_ROOT_USER=local-minio-admin
MINIO_ROOT_PASSWORD=local-minio-change-me
MINIO_API_PORT=9000
MINIO_CONSOLE_PORT=9001

OBJECT_STORAGE_ENDPOINT=http://127.0.0.1:9000
OBJECT_STORAGE_REGION=us-east-1
OBJECT_STORAGE_BUCKET=certificate-platform-private
OBJECT_STORAGE_ACCESS_KEY=local-minio-admin
OBJECT_STORAGE_SECRET_KEY=local-minio-change-me
OBJECT_STORAGE_FORCE_PATH_STYLE=true
OBJECT_STORAGE_CREATE_BUCKET=true
```

### Participant Import Limits

```env
PARTICIPANT_IMPORT_MAX_BYTES=5242880
PARTICIPANT_IMPORT_MAX_ROWS=10000
PARTICIPANT_IMPORT_MAX_UNCOMPRESSED_BYTES=26214400
PARTICIPANT_IMPORT_RETENTION_HOURS=168
PARTICIPANT_IMPORT_CONCURRENCY=2
BULLMQ_PREFIX=certificate-platform
```

Current limits:

- compressed/source upload maximum = 5 MiB
- rows maximum = 10,000
- uncompressed maximum = 25 MiB
- retention = 168 hours = 7 days
- worker concurrency = 2

### Application Ports

```env
API_HOST=0.0.0.0
API_PORT=3001

WORKER_HOST=0.0.0.0
WORKER_HEALTH_PORT=3002

READINESS_TIMEOUT_MS=2000

NEXT_PUBLIC_API_BASE_PATH=/api
API_INTERNAL_BASE_URL=http://127.0.0.1:3001
```

---

# 11. Docker Infrastructure

## 11.1 Recommended local development model

จนกว่า Group 7 Docker/workspace fixes จะเสร็จ แนะนำ:

```text
Docker: PostgreSQL + Redis + MinIO
Host:   Next.js + API + Worker
```

ไม่แนะนำให้ใช้ full Docker app build เป็น development source-of-truth ตอนนี้ เพราะ Dockerfile/workspace manifest handling ยังอยู่ใน Phase 4.5 Group 7 backlog

## 11.2 Start infrastructure

```powershell
docker compose up -d postgres redis minio
```

ตรวจ:

```powershell
docker compose ps
```

ควรเห็น:

```text
postgres  healthy
redis     healthy
minio     healthy
```

ดู logs:

```powershell
docker compose logs postgres
docker compose logs redis
docker compose logs minio
```

ติดตาม live:

```powershell
docker compose logs -f postgres redis minio
```

## 11.3 Stop infrastructure

หยุดโดยเก็บ volumes:

```powershell
docker compose down
```

## 11.4 Delete all local Docker data

**Destructive**

```powershell
docker compose down -v
```

คำสั่งนี้ลบ local named volumes ของ:

- PostgreSQL
- Redis
- MinIO

อย่ารันถ้ายังต้องการ local development data

## 11.5 Service network design

Compose แยก network:

- `edge`
- `diagnostics`
- `internal`

PostgreSQL/Redis/MinIO ถูก bind host port ที่ `127.0.0.1` เพื่อจำกัด local exposure

---

# 12. Database และ Migrations

Database package:

```text
packages/database
```

Migration runner:

```text
node-pg-migrate
```

## 12.1 Current migrations

Checkpoint หลัง Group 5B:

```text
202608170001_initial-canonical-schema.ts
202608180002_seed-rbac.ts
202608210003_queue-outbox.ts
202608210004_storage-cleanup-outbox.ts
```

## 12.2 Apply migrations to development DB

ตรวจ PostgreSQL ก่อน:

```powershell
docker compose up -d postgres
docker compose ps
```

จากนั้น:

```powershell
pnpm db:migrate
```

ตรวจ status:

```powershell
pnpm db:migrate:status
```

## 12.3 Migration rule

เมื่อ migration ถูกใช้แล้ว:

- อย่าแก้ migration เก่าย้อนหลังแบบเงียบ ๆ
- schema change ใหม่ควรสร้าง migration ใหม่
- อย่าแก้ production DB ด้วย manual SQL แล้วไม่บันทึก migration

Initial migration อ้าง canonical schema snapshot และ checksum เพื่อป้องกัน schema drift

## 12.4 Fresh DB reset

ถ้าเป็น disposable development DB:

```powershell
docker compose down -v
docker compose up -d postgres redis minio
pnpm db:migrate
```

ระวัง: `down -v` ลบข้อมูลทั้งหมด

---

# 13. การรัน Development

หลัง infra healthy + migration:

```powershell
pnpm dev
```

root script รันพร้อมกัน:

```text
@certificate-platform/web
@certificate-platform/api
@certificate-platform/worker
```

ถ้าต้อง debug ทีละ service ใช้ workspace filter เช่น:

```powershell
pnpm --filter @certificate-platform/web dev
pnpm --filter @certificate-platform/api dev
pnpm --filter @certificate-platform/worker dev
```

เปิดคนละ terminal จะ debug ง่ายกว่า

---

# 14. Health Checks และ Service URLs

Default local URLs:

| Service | URL |
|---|---|
| Web | `http://localhost:3000` |
| API | `http://localhost:3001` |
| API live | `http://localhost:3001/health/live` |
| API ready | `http://localhost:3001/health/ready` |
| Worker live | `http://localhost:3002/health/live` |
| Worker ready | `http://localhost:3002/health/ready` |
| MinIO API | `http://localhost:9000` |
| MinIO Console | `http://localhost:9001` |
| PostgreSQL | `127.0.0.1:5432` |
| Redis | `127.0.0.1:6379` |

PowerShell:

```powershell
Invoke-WebRequest http://127.0.0.1:3001/health/live
Invoke-WebRequest http://127.0.0.1:3001/health/ready
Invoke-WebRequest http://127.0.0.1:3002/health/live
Invoke-WebRequest http://127.0.0.1:3002/health/ready
```

`live` หมายถึง process ยังทำงาน

`ready` ควรสะท้อน dependency readiness ตามที่ application ตรวจ

---

# 15. Testing

## 15.1 Root commands

```powershell
pnpm lint
pnpm build
pnpm typecheck
pnpm test
pnpm test:security
pnpm test:integration
pnpm test:e2e
```

## 15.2 Recommended pre-push gate

```powershell
pnpm lint
pnpm build
pnpm typecheck
pnpm test:security
pnpm test:integration
git diff --check
```

ใช้ลำดับ `build -> typecheck` เพื่อ reproduce clean CI behavior

## 15.3 Security suite

```powershell
pnpm test:security
```

Checkpoint:

```text
17 test files
57 tests passed
```

ครอบคลุม:

- authorization
- session behavior
- password
- rate limiting
- upload validation
- template schema
- queue primitives
- tenant isolation
- phase 3/4 authorization

## 15.4 Integration suite

Integration tests ใช้ external PostgreSQL/Redis

root script:

```text
vitest run --no-file-parallelism apps/api/tests/integration apps/worker/tests/integration
```

เรา intentionally ปิด test-file parallelism เพราะ integration files แชร์ external infrastructure และ dispatcher/outbox มีสิทธิ์ consume shared database rows ข้าม test file ถ้ารันพร้อมกัน

Checkpoint หลัง Group 5B:

```text
Test Files  9 passed (9)
Tests       27 passed (27)
```

## 15.5 Create test PostgreSQL database

เริ่ม PostgreSQL:

```powershell
docker compose up -d postgres
```

สร้าง test DB:

```powershell
docker compose exec -T postgres createdb -U certificate_app certificate_platform_test
```

ถ้าแจ้งว่า database already exists สามารถใช้ของเดิมได้ถ้าตั้งใจ

## 15.6 Set test URLs — default ports

PowerShell:

```powershell
$env:TEST_DATABASE_URL="postgresql://certificate_app:local-postgres-change-me@127.0.0.1:5432/certificate_platform_test"
$env:DATABASE_URL=$env:TEST_DATABASE_URL
$env:TEST_REDIS_URL="redis://:local-redis-change-me@127.0.0.1:6379"
```

Apply migrations เข้า **test DB**:

```powershell
pnpm db:migrate
```

จากนั้น:

```powershell
pnpm test:integration
```

### Test database guard

Integration tests ตั้งใจ require database pathname ที่มีคำว่า `test`

อย่าเอา production DB URL มาใส่ `TEST_DATABASE_URL`

## 15.7 หลังรัน test แล้ว clear PowerShell overrides

สำคัญ เพราะ `DATABASE_URL` ที่ตั้งใน shell อาจ override `.env`

```powershell
Remove-Item Env:TEST_DATABASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:TEST_REDIS_URL -ErrorAction SilentlyContinue
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
```

เปิด terminal ใหม่ก็เป็นวิธีง่ายที่สุดในการ reset environment overrides

## 15.8 Test Redis

Local Compose Redis ใช้ password

ดังนั้น:

```text
redis://:PASSWORD@127.0.0.1:6379
```

CI Redis ปัจจุบันเป็น isolated CI service ที่ไม่ใช้ password ดังนั้น CI ใช้:

```text
redis://127.0.0.1:6379
```

อย่าสับสนสอง environment นี้

---

# 16. GitHub Actions / CI / Branch Protection

Workflow:

```text
.github/workflows/ci.yml
```

CI version baseline:

```text
Node 24.19.0
pnpm 11.5.2
```

## Quality Gate

รัน:

```text
Install
Lint
Build
Typecheck
Security tests
```

## Integration Gate

สร้าง CI services:

- PostgreSQL 16
- Redis 8.2.3

แล้ว:

```text
Install
Apply database migrations
Run integration tests
```

## Why CI builds before typecheck

Workspace packages บาง package export type declaration จาก `dist/`

บน development machine ที่เคย build มาแล้ว `pnpm typecheck` อาจผ่าน

แต่ clean CI runner ไม่มี `dist/`

ดังนั้น canonical clean-runner order คือ:

```text
Build
Typecheck
```

## Required checks on main

Ruleset ของ `main` ต้อง require:

```text
Quality Gate
Integration Gate
```

PR ที่ checks ไม่ผ่านไม่ควรถูก merge

---

# 17. ระบบ Authentication / Session / RBAC

## Authentication

Admin authentication ใช้:

```text
bcrypt password
+
Redis server-side session
+
secure cookie
+
CSRF token
```

ไม่ใช้ browser-stored JWT เป็น canonical admin session

## Session integrity

มี fix สำหรับ revoke/touch race:

เดิม concurrent request อาจ:

1. read session
2. logout ลบ Redis key
3. stale request touch session
4. unconditional `SET` สร้าง session ที่ถูก revoke กลับมา

ตอนนี้ touch behavior ใช้ semantics เทียบเท่า:

```text
SET ... XX
```

จึงต่ออายุได้เฉพาะ key ที่ยังมีอยู่

session ที่ถูก revoke แล้วจะไม่ถูก stale request resurrect

## RBAC

Authorization พิจารณา:

- user
- organization membership
- roles
- permissions
- tenant context

cross-tenant access ต้องไม่สำเร็จแม้ user คนเดียวเป็น member หลายองค์กร

## CSRF

State-changing admin request ต้องผ่าน CSRF + origin policy

Local admin origin:

```env
ADMIN_ALLOWED_ORIGINS=http://localhost:3000
```

---

# 18. Project / Training / Participant Flow

Conceptual hierarchy:

```text
Organization
└─ Project
   └─ Training
      └─ Participant relationship
```

Participant entity สามารถถูกสัมพันธ์กับ training ผ่าน `training_participants`

Admin functionality Phase 3 รวม:

- create/update/archive project
- create/update/archive training
- participant read/update
- import participants
- preview validation
- confirm import

ทุก operation ต้อง tenant scoped

---

# 19. Participant Import / Queue Durability

Participant import เป็น asynchronous workflow

## High-level flow

```mermaid
sequenceDiagram
    participant A as API
    participant P as PostgreSQL
    participant S as S3/MinIO
    participant D as Outbox Dispatcher
    participant Q as BullMQ/Redis
    participant W as Worker

    A->>S: upload source file
    A->>P: transaction job + detail + queue_outbox + audit
    D->>P: claim durable outbox intent
    D->>Q: enqueue deterministic BullMQ job
    D->>P: mark outbox dispatched
    Q->>W: deliver job
    W->>P: validate/update authoritative state
```

## Idempotency

Import request fingerprint binds:

- organization
- operation
- training
- source content SHA-256

behavior:

```text
same idempotency key + same fingerprint
=> reuse original logical import

same idempotency key + different fingerprint
=> conflict
```

Browser retry ต้อง reuse idempotency key สำหรับ logical request เดิม

## Queue outbox

เหตุผล:

DB commit แล้ว BullMQ enqueue fail ไม่ควรทำ job ค้าง `QUEUED` ตลอดไป

ดังนั้น queue intent ถูกสร้างใน PostgreSQL transaction เดียวกับ authoritative job

Worker dispatcher:

- claim pending outbox
- enqueue BullMQ
- mark dispatched หลัง enqueue สำเร็จ
- retry failure
- reconcile stale queued jobs

PostgreSQL เป็น authoritative state

BullMQ เป็น delivery mechanism

---

# 20. Template / Asset / Version Flow

## Template

```text
certificate_templates
```

template เป็น parent metadata

## Asset

รองรับ:

- PNG
- JPEG
- TTF
- OTF

client-provided filename / MIME type ไม่ถือเป็น trusted evidence

asset ถูก validate ก่อน persist

binary เก็บ private object storage

metadata เก็บ PostgreSQL

## Template Definition

definition ใช้ custom JSON ที่ validate ด้วย Zod

ไม่รับ arbitrary executable code

ตัวอย่าง concept:

```json
{
  "format_version": 1,
  "page": {
    "width": 500,
    "height": 300,
    "unit": "px"
  },
  "elements": []
}
```

## Asset references

template definition สามารถ reference image/font asset IDs

Group 5A hardening:

- asset validation ก่อน insert version
- ป้องกัน ghost draft
- lock referenced asset rows
- deterministic asset lock order
- publish ถือ asset locks จน transaction commit
- ป้องกัน concurrent archive ทำ published template invalid

## Published immutability

PostgreSQL triggers enforce:

- published/archived definition cannot mutate
- published/archived rendering inputs cannot mutate
- asset links ของ published version immutable
- asset content/status ที่ถูกใช้โดย published versionถูก protect
- invalid lifecycle transitions ถูก reject

อย่า rely เฉพาะ application validation เมื่อ DB invariant สามารถ enforce ได้

---

# 21. Object Storage Consistency

## Problem

S3/MinIO และ PostgreSQL ไม่มี distributed ACID transaction ร่วมกัน

ตัวอย่าง failure:

```text
1. object upload สำเร็จ
2. DB insert/audit fail
3. immediate object delete fail
4. object กลายเป็น orphan
```

การเขียนแค่:

```ts
storage.delete(...).catch(() => undefined)
```

ไม่พอสำหรับ reliability

## Group 5B design

ใช้ durable:

```text
storage_cleanup_outbox
```

Flow:

```text
1. PRE-ARM cleanup intent in PostgreSQL
2. upload object
3. create asset row + audit
4. ถ้า commit สำเร็จ -> cancel cleanup intent ใน transaction
5. ถ้า failure -> cleanup intent ยังอยู่
6. worker retries object deletion
```

ก่อน worker ลบ object จะตรวจ database reference อีกครั้ง

ถ้า object กลายเป็น referenced authoritative data:

```text
do not delete
remove stale cleanup intent
```

reference guard ตรวจ storage keys จาก:

- `template_assets`
- `participant_import_jobs`
- `certificates`

จุดนี้ช่วยวาง foundation สำหรับ future certificate storage ด้วย

---

# 22. Public Verification Architecture

Public verification ยังเป็น Phase 6 แต่ design ถูก lock ไว้แล้ว

## Requirements

- no recipient login required
- no sequential public ID
- no student-code enumeration
- signed stateless verification secret
- opaque public identifier
- database status check
- rate limiting
- revoke-aware
- secure download

Concept:

```text
public verification request
        |
        v
validate signed token
        |
        v
resolve opaque certificate identity
        |
        v
read PostgreSQL certificate state
        |
        +--> valid
        +--> revoked
        +--> archived
        +--> unavailable
```

Secret/token validation อย่างเดียวไม่พอ เพราะ revoke ต้องมี authoritative DB state

---

# 23. Production Safety Gates

ระบบ **ยังไม่ production ready**

## MFA Gate

Phase 2 intentionally blocks approved production startup until MFA contract/implementation ได้รับการอนุมัติ

ห้ามแก้ด้วยการ:

- hardcode bypass
- disable gate
- set insecure fallback
- weaken auth checks

เพื่อเพียงให้ deployment start ได้

## Phase 5 gate

ห้ามเริ่ม certificate generation จน Phase 4.5 integrity work ผ่าน final gate

## Current remaining Phase 4.5 groups

```text
Group 6 — Import cleanup reliability
Group 7 — Docker/workspace build fixes
Group 8 — Pre-Phase 5 integrity contracts + final verification
```

---

# 24. Troubleshooting

## 24.1 PostgreSQL port 5432 already in use

ตรวจ:

```powershell
Get-NetTCPConnection -LocalPort 5432 -ErrorAction SilentlyContinue
```

ถ้ามี native PostgreSQL ใช้อยู่ ให้เปลี่ยน local Docker host port เช่น `55432`

ใน `.env`:

```env
POSTGRES_PORT=55432
DATABASE_URL=postgresql://certificate_app:local-postgres-change-me@127.0.0.1:55432/certificate_platform
```

restart container:

```powershell
docker compose up -d --force-recreate postgres
```

test URL:

```powershell
$env:TEST_DATABASE_URL="postgresql://certificate_app:local-postgres-change-me@127.0.0.1:55432/certificate_platform_test"
$env:DATABASE_URL=$env:TEST_DATABASE_URL
```

## 24.2 Redis integration authentication error

Local Compose Redis มี `requirepass`

ใช้ URL:

```text
redis://:local-redis-change-me@127.0.0.1:6379
```

ถ้า password ถูกเปลี่ยน ตรวจ `.env`

หรือ inspect running command:

```powershell
docker inspect certificate-platform-redis-1 --format '{{json .Config.Cmd}}'
```

ชื่อ container อาจต่างกันตาม Compose version/project name

วิธีที่ดีกว่าคือให้ `REDIS_PASSWORD` / `TEST_REDIS_URL` มาจาก configuration ที่รู้ค่าอยู่แล้ว ไม่ควร hardcode random password ใน test

## 24.3 Integration test BullMQ flaky when all files run together

อย่าเอา `--no-file-parallelism` ออกจาก root `test:integration` โดยไม่มี redesign ของ test isolation

เหตุผล:

- integration files share PostgreSQL
- dispatcher scans global pending outbox rows
- parallel files สามารถ claim fixture ของกันและกัน

current script:

```text
vitest run --no-file-parallelism apps/api/tests/integration apps/worker/tests/integration
```

## 24.4 Clean machine typecheck fails with missing workspace types

รัน:

```powershell
pnpm build
pnpm typecheck
```

ไม่ใช่:

```text
typecheck first on an unbuilt clean workspace
```

CI ใช้ Build ก่อน Typecheck

## 24.5 Git "dubious ownership"

ถ้า repo ถูกย้าย drive/user แล้ว Git แจ้ง:

```text
fatal: detected dubious ownership in repository
```

และคุณยืนยันว่า directory นี้เป็น repo ที่เชื่อถือได้:

```powershell
git config --global --add safe.directory D:/certificate-platform-complete
```

เปลี่ยน path ให้ตรงเครื่องใหม่

อย่า whitelist directory ที่ไม่เชื่อถือ

## 24.6 LF / CRLF warnings

Windows อาจแสดง warning เรื่อง LF → CRLF

warning ไม่เท่ากับ whitespace error

ใช้:

```powershell
git diff --check
```

เป็น actual whitespace gate

## 24.7 Docker container unhealthy

```powershell
docker compose ps
docker compose logs postgres
docker compose logs redis
docker compose logs minio
```

ตรวจ `.env`, port conflict และ password mismatch

## 24.8 MinIO console login

Default local:

```text
URL:      http://localhost:9001
Username: local-minio-admin
Password: local-minio-change-me
```

ถ้าแก้ `.env` ให้ใช้ค่าที่แก้

## 24.9 Migration accidentally targets wrong DB

ก่อน migrate test DB:

```powershell
Write-Host $env:DATABASE_URL
```

หลัง test:

```powershell
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
```

อย่ารัน migration โดยไม่รู้ว่า `DATABASE_URL` ชี้ที่ไหน

---

# 25. Backup / Restore สำหรับย้ายเครื่อง

## Git ไม่ได้เก็บ local service data

การ `git push` จะเก็บ:

- source code
- migrations
- docs
- tests

แต่ **ไม่เก็บ**:

- `.env`
- PostgreSQL Docker volume
- Redis Docker volume
- MinIO Docker volume
- uncommitted source files

ดังนั้นเลือกว่าจะย้ายแค่ source code หรือย้าย development data ด้วย

## 25.1 ถ้าไม่ต้องการ local test/dev data

ง่ายที่สุด:

1. push source code
2. clone ที่บ้าน
3. สร้าง `.env` ใหม่
4. `docker compose up -d postgres redis minio`
5. `pnpm db:migrate`

Redis sessions/queue state เก่าสามารถทิ้งได้ใน development

PostgreSQL/BullMQ architecture ถูกออกแบบให้ business state ไม่พึ่ง Redis เป็น source-of-truth

## 25.2 PostgreSQL development DB backup

สร้าง folder:

```powershell
New-Item -ItemType Directory -Force .\backups
```

dump ใน container:

```powershell
docker compose exec -T postgres pg_dump `
  -U certificate_app `
  -d certificate_platform `
  -Fc `
  -f /tmp/certificate_platform.dump
```

copy ออก:

```powershell
docker compose cp postgres:/tmp/certificate_platform.dump .\backups\certificate_platform.dump
```

**อย่า commit database dump เข้า Git**

ย้ายไฟล์ด้วย USB/private storage ที่เหมาะสม

## 25.3 PostgreSQL restore

บนเครื่องใหม่ start PostgreSQL ก่อน:

```powershell
docker compose up -d postgres
```

copy dump เข้า container:

```powershell
docker compose cp .\backups\certificate_platform.dump postgres:/tmp/certificate_platform.dump
```

restore:

```powershell
docker compose exec -T postgres pg_restore `
  -U certificate_app `
  -d certificate_platform `
  --clean `
  --if-exists `
  /tmp/certificate_platform.dump
```

`--clean` destructive ต่อ database เป้าหมาย

ใช้เฉพาะกับ development database ที่ตั้งใจ replace

## 25.4 MinIO data

ถ้าต้องการรักษา template/import objects จากเครื่องเก่า ต้องย้าย object storage data ด้วย

ถ้าไม่ต้องการ development fixtures เก่า แนะนำสร้าง MinIO volume ใหม่และ re-upload fixture เพราะง่ายและปลอดภัยกว่า

จำไว้ว่า PostgreSQL row ที่อ้าง storage key แต่ MinIO object ไม่ได้ย้ายมาจะทำให้ local development data inconsistent

## 25.5 `.env`

`.env` ไม่อยู่ใน Git

สำหรับ development:

- สร้างใหม่จาก `.env.example`
- generate `SESSION_SECRET` ใหม่
- ใช้ local passwords ใหม่ได้ถ้าเริ่ม DB/Redis/MinIO ใหม่

ถ้าย้าย DB/MinIO volume เก่า ควรรักษา credentials/config ที่จำเป็นให้ตรง

---

# 26. Development Workflow

## Rule: small, reviewable changes

อย่าทำหลาย phase ใน commit เดียว

รูปแบบที่ใช้ใน stabilization:

```text
inspect current branch
identify one integrity defect
make small patch
run targeted test
run security/integration gates
commit
push
wait CI
continue
```

## Before coding

```powershell
git switch fix/phase-4-5-stabilization
git pull --ff-only
git status
```

ต้องรู้ว่า working tree clean หรือไม่

## After a change

targeted:

```powershell
pnpm vitest run <specific-test-file>
```

then full gates:

```powershell
pnpm lint
pnpm build
pnpm typecheck
pnpm test:security
pnpm test:integration
git diff --check
```

## Commit style examples

```text
fix(auth): prevent revoked session resurrection
fix(import): bind idempotency keys to import requests
fix(queue): add durable outbox and reconciliation
fix(audit): make relational mutations transactional
fix(templates): make asset validation race-safe
fix(storage): add durable object cleanup reconciliation
test(integration): serialize shared external resources
```

## Push

```powershell
git push
```

แล้วตรวจ GitHub CI

## Do not merge Draft stabilization PR yet

PR #1 ต้องอยู่ Draft จน:

- Group 6 done
- Group 7 done
- Group 8 done
- final full verification green

---

# 27. Next Work

## NEXT: Group 6 — Participant Import Cleanup Reliability

Known issues to investigate/fix:

1. cleanup failure ไม่ควรเปลี่ยน successful business processing ให้กลายเป็น unrelated `DEAD_LETTER`
2. terminal jobs ไม่ควรพยายาม cleanup ซ้ำ forever โดยไม่มี cleanup state
3. cleanup outcome ควรมี durable metadata/retry semantics
4. storage/database cleanup order ต้องไม่สร้าง orphan หรือ destroy required evidence
5. เพิ่ม integration tests สำหรับ delete failure + later recovery

## Then: Group 7 — Docker / Workspace Build

Known work:

- inspect Dockerfile workspace manifest copies
- `packages/template-engine/package.json` ต้องถูกพิจารณาใน clean Docker install
- verify filtered builds from clean checkout
- add Docker build verification
- avoid relying on stale `dist` generated locally

ณ checkpoint นี้ full application Docker build ยังไม่ควรถูกถือว่าเป็น production-proven path

## Then: Group 8 — Pre-Phase 5 Integrity Contracts

ก่อน Phase 5:

- immutable certificate issuance/render snapshot design
- certificate lifecycle transition guards
- renderer isolation / untrusted input boundary
- final queue/storage integrity verification
- final CI gate

## Phase 5 after Group 8 only

Phase 5:

```text
Certificate Generation
PDF
QR
generation queue
object storage
certificate lifecycle
```

อย่าข้าม stabilization เพื่อไป PDF generation เร็วขึ้น

---

# 28. Document Map

เริ่มจาก:

```text
README.md
CODEX-START-HERE.md
AGENTS.md
IMPLEMENTATION-ROADMAP.md
```

เอกสารหลัก:

```text
docs/00-project-overview.md
docs/01-system-architecture.md
docs/02-security-privacy.md
docs/03-technology-stack.md
docs/04-repository-layout-and-naming.md
docs/05-database-design.md
docs/07-testing-strategy.md
docs/08-erd.md
docs/09-postgresql-schema.sql
docs/10-api-contract.md
docs/11-token-spec.md
docs/12-template-engine.md
docs/13-pdf-generation.md
docs/14-zcode-glm-workflow.md
docs/15-mvp-checklist.md
docs/16-user-flows.md
docs/17-ui-specification.md
docs/18-roles-permissions.md
docs/19-openapi-outline.md
docs/20-deployment.md
docs/21-observability.md
docs/22-privacy-policy-design.md
docs/23-threat-model.md
docs/24-adr.md
docs/25-ai-prompts.md
docs/26-definition-of-done.md
```

### Important

Specification อาจอธิบาย future phase ที่ยังไม่ได้ implement

เวลาเช็กว่า "ระบบทำได้แล้วหรือยัง" ให้ตรวจ:

1. implementation code
2. integration tests
3. roadmap/current checkpoint
4. CI

อย่าใช้ spec เพียงอย่างเดียวเป็น implementation status

---

# 29. Quick Command Reference

## Fresh machine

```powershell
git clone https://github.com/famsrt27-cloud/certificate-manager.git
cd certificate-manager

git fetch --all --prune
git switch fix/phase-4-5-stabilization
git pull --ff-only

corepack enable
corepack prepare pnpm@11.5.2 --activate

pnpm install --frozen-lockfile
Copy-Item .env.example .env
```

แก้ `.env` แล้ว:

```powershell
docker compose up -d postgres redis minio
docker compose ps

pnpm db:migrate

pnpm build
pnpm typecheck
pnpm test:security
```

start:

```powershell
pnpm dev
```

## Full integration setup

```powershell
docker compose exec -T postgres createdb -U certificate_app certificate_platform_test

$env:TEST_DATABASE_URL="postgresql://certificate_app:local-postgres-change-me@127.0.0.1:5432/certificate_platform_test"
$env:DATABASE_URL=$env:TEST_DATABASE_URL
$env:TEST_REDIS_URL="redis://:local-redis-change-me@127.0.0.1:6379"

pnpm db:migrate
pnpm test:integration
```

clear test overrides:

```powershell
Remove-Item Env:TEST_DATABASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:TEST_REDIS_URL -ErrorAction SilentlyContinue
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
```

## Normal resume

```powershell
git switch fix/phase-4-5-stabilization
git pull --ff-only
git status

docker compose up -d postgres redis minio
pnpm db:migrate
pnpm dev
```

## Pre-push

```powershell
pnpm lint
pnpm build
pnpm typecheck
pnpm test:security
pnpm test:integration
git diff --check
git status
```

## Commit / push

```powershell
git add <reviewed-files>
git diff --cached --check
git diff --cached
git commit -m "<message>"
git push
```

---

# Final Safety Notes

- `.env` ห้าม commit
- production secret ห้ามใช้ค่าจาก `.env.example`
- test DB URL ต้องเป็น test DB จริง
- `docker compose down -v` destructive
- Redis ไม่ใช่ authoritative business store
- public verification ห้ามใช้ sequential IDs/student code เป็น secret
- published template rendering inputs ต้อง immutable
- mutation + audit ต้อง atomic เมื่อทำได้ใน PostgreSQL
- queue intent ต้อง durable
- object cleanup failure ต้อง retry ได้
- production MFA gate ห้าม bypass
- PR stabilization ยังไม่ควร merge
- งานถัดไปคือ **Group 6**, ไม่ใช่ Phase 5

---

## Checkpoint Summary — 2026-08-21

```text
Project: Certificate Management & Public Verification Platform
Branch:  fix/phase-4-5-stabilization
PR:      #1 (Draft)

Phase 1: implemented
Phase 2: implemented non-production; production MFA gate active
Phase 3: implemented
Phase 4: implemented template management
Phase 4.5:
  Group 1  ✅
  Group 2  ✅
  Group 3  ✅
  Group 4  ✅
  Group 5A ✅
  Group 5B ✅ behavior/integration verification

Latest verified checkpoint:
  Security suite:    57/57
  Integration suite: 27/27
  Phase 4:            8/8
  Storage cleanup:    2/2

Next:
  Group 6 — Participant Import Cleanup Reliability
```

ก่อนย้ายเครื่องให้แน่ใจว่า **Group 5B + README นี้ถูก commit และ push แล้ว** และ GitHub CI กลับมาเขียวก่อนเริ่มงานต่อที่เครื่องใหม่
