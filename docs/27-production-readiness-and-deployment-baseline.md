# 27 — Production Readiness and Deployment Baseline

## Status and authority

This document is the source-backed Phase 8.1 readiness audit for repository base
`74573bbf9a0b7ee356a36d3a2b333e00b5c0ed28`. It records current behavior and the
remaining production work; it does not declare the platform production-ready.

The approved architecture, stack, deployment model, and observability requirements
remain owned by `docs/01-system-architecture.md`, `docs/03-technology-stack.md`,
`docs/20-deployment.md`, and `docs/21-observability.md`. This document applies those
contracts to the current implementation instead of replacing them.

Assumptions:

- One deployment serves the Next.js web application and Fastify API as one first-party
  site through a future TLS/reverse-proxy boundary.
- PostgreSQL, Redis, and S3-compatible object storage are private dependencies.
- MinIO in `compose.yaml` is the local S3-compatible implementation, not a requirement
  to operate MinIO in production.
- Environment values described as defaults are development conveniences, not approved
  production values.

## 1. Phase 8 scope

Phase 8 makes the already implemented application deployable and operable without
weakening its security or data-integrity boundaries. It covers production
authentication, ingress/TLS, runtime packaging, network exposure, managed
configuration and secrets, migrations, monitoring, backup/restore, rollback, and a
final production rehearsal.

Phase 8.1 is documentation and audit only. Its deliverable is an evidence-based
baseline, configuration inventory, persistent-data inventory, observability baseline,
and blocker matrix. No production behavior is changed in this part.

## 2. Current architecture

The current code implements three independently started application processes:

- `apps/web`: Next.js admin and public verification UI. It rewrites same-origin
  `/api/*` requests to the Fastify origin selected by `API_INTERNAL_BASE_URL`.
- `apps/api`: Fastify admin/public API, authentication, rate limiting, PostgreSQL,
  Redis, BullMQ producer, and private object-storage adapters.
- `apps/worker`: participant-import and certificate-generation BullMQ workers,
  PostgreSQL outbox/cleanup reconciliation, private object-storage access, and an
  internal Fastify health server.

PostgreSQL is authoritative for business, certificate, audit, job, generation, and
outbox state. Redis holds server-side sessions, distributed rate-limit counters, and
BullMQ transport/state. Private S3-compatible storage holds participant-import source
objects, template assets, and certificate PDFs. The certificate renderer consumes a
strict, versioned, capability-minimized input, but it currently executes inside the
trusted worker process rather than in an independently resource-isolated process.

Evidence: `apps/api/src/server.ts`, `apps/worker/src/server.ts`,
`apps/web/next.config.ts`, `packages/database/src/database.ts`,
`packages/queue/src/redis-connection.ts`, and
`packages/certificate-renderer/src/render-input.ts`.

## 3. Deployment topology

```text
Internet
  |
  v
future TLS / reverse-proxy boundary                 NOT IMPLEMENTED
  |------------------------------|
  v                              v
Next.js web :3000             Fastify API :3001
  | same-origin /api rewrite      |-- PostgreSQL :5432 (private)
  +------------------------------>|-- Redis :6379 (private)
                                  |-- S3/MinIO API :9000 (private)

Worker (no public application port)
  |-- internal health :3002
  |-- PostgreSQL
  |-- Redis / BullMQ
  |-- private S3-compatible storage
  +-- capability-minimized renderer package
```

The logical production route is `Internet -> future TLS/reverse proxy -> Web/API`.
The API and web service may both be proxy upstreams, but browser `/api/*` traffic must
remain same-site unless a later ADR approves a different cookie/CSRF model. Only the
proxy edge should accept Internet traffic in the final topology.

## 4. Service exposure matrix

| Service/interface | Current local Compose exposure | Production requirement | Classification |
| --- | --- | --- | --- |
| TLS/reverse proxy | Absent | Public ports 80/443 as required; redirect HTTP to HTTPS and proxy only approved routes | Public edge, `NOT_IMPLEMENTED` |
| Web | Host port `${WEB_PORT:-3000}` to container `3000` | Reachable only through the proxy; no database, Redis, object-storage, or signing credentials | Public through edge |
| API | Host port `${API_PORT:-3001}` to container `3001`, bound on all host interfaces by default | Reachable only through the proxy/internal web path; direct Internet exposure prohibited | Public through edge only |
| Worker health | Container port `3002`; no host publication | Private monitoring/orchestrator access only | Private |
| PostgreSQL | Loopback host port `${POSTGRES_PORT:-5432}` | No public port; reachable only by API, worker, migration/operations boundary | Private |
| Redis | Loopback host port `${REDIS_PORT:-6379}` | No public port; reachable only by API and worker | Private |
| MinIO/S3 API | Loopback host port `${MINIO_API_PORT:-9000}` | Private provider/API access only; bucket and objects must remain private | Private |
| MinIO console | Loopback host port `${MINIO_CONSOLE_PORT:-9001}` | No public exposure; omit for managed S3 or restrict to an operator boundary | Private operator surface |
| Migration command | `migrate` tools-profile service, no port | One explicitly invoked, mutually exclusive deployment step | Private operations surface |

Evidence: `compose.yaml:44-183`, `docs/20-deployment.md`, and
`apps/web/next.config.ts`.

## 5. Production environment inventory

Classification meanings:

- `PUBLIC`: intentionally safe for browser exposure.
- `NON-SECRET CONFIG`: operational policy that is not confidential.
- `SECRET`: credential material or a credential-bearing URL that must use managed
  injection and redaction.
- `GENERATED SECRET`: high-entropy cryptographic material that must be generated and
  rotated outside source control.
- `DEPLOYMENT-SPECIFIC`: non-secret topology/name/address selected per environment.

“Default” below means the schema or local Compose supplies a value. Production must
still select and review it explicitly where stated.

### 5.1 API

| Variable | Classification | Current contract / production note |
| --- | --- | --- |
| `NODE_ENV` | DEPLOYMENT-SPECIFIC | Enum; defaults to `development`; production must be explicit. |
| `LOG_LEVEL` | NON-SECRET CONFIG | Validated Pino level; defaults to `info`. |
| `DATABASE_URL` | SECRET | Required PostgreSQL URL; normally contains credentials. |
| `DATABASE_MAX_CONNECTIONS` | NON-SECRET CONFIG | Integer 1–100; default 10. |
| `REDIS_URL` | SECRET | Required Redis URL; normally contains credentials. |
| `READINESS_TIMEOUT_MS` | NON-SECRET CONFIG | 100–30,000 ms; default 2,000. |
| `API_HOST`, `API_PORT` | DEPLOYMENT-SPECIFIC | Defaults `0.0.0.0` and `3001`. |
| `ADMIN_ALLOWED_ORIGINS` | DEPLOYMENT-SPECIFIC | Exact comma-separated origins; every production origin must be HTTPS. |
| `SESSION_SECRET` | GENERATED SECRET | Required, at least 32 UTF-8 bytes; used for session/rate-limit/cursor HMAC material. |
| `SESSION_IDLE_TTL_SECONDS`, `SESSION_ABSOLUTE_TTL_SECONDS` | NON-SECRET CONFIG | Bounded session policy; defaults 1,800 and 28,800 seconds. |
| `BCRYPT_COST` | NON-SECRET CONFIG | Integer 12–15; default 12. |
| `LOGIN_RATE_LIMIT_WINDOW_SECONDS`, `LOGIN_RATE_LIMIT_ACCOUNT_MAX`, `LOGIN_RATE_LIMIT_NETWORK_MAX` | NON-SECRET CONFIG | Bounded login throttling policy; defaults 900/5/20. |
| `PUBLIC_VERIFICATION_RATE_LIMIT_WINDOW_SECONDS`, `PUBLIC_VERIFICATION_RATE_LIMIT_NETWORK_MAX` | NON-SECRET CONFIG | Bounded verification policy; defaults 60/30. |
| `PUBLIC_DOWNLOAD_TOKEN_TTL_SECONDS` | NON-SECRET CONFIG | 1–60 seconds; default 60. |
| `PUBLIC_DOWNLOAD_AUTHORIZE_RATE_LIMIT_WINDOW_SECONDS`, `PUBLIC_DOWNLOAD_AUTHORIZE_RATE_LIMIT_NETWORK_MAX` | NON-SECRET CONFIG | Bounded authorization policy; defaults 60/10. |
| `PUBLIC_DOWNLOAD_RATE_LIMIT_WINDOW_SECONDS`, `PUBLIC_DOWNLOAD_RATE_LIMIT_NETWORK_MAX` | NON-SECRET CONFIG | Bounded redemption policy; defaults 60/10. |
| `TEMPLATE_ASSET_MAX_BYTES`, `CERTIFICATE_PDF_MAX_BYTES` | NON-SECRET CONFIG | Bounded resource limits; defaults 5 MiB and 10 MiB. |
| `VERIFICATION_ACTIVE_KID` | NON-SECRET CONFIG | Key identifier, **not a secret**; must be a member of the configured key set. |
| `VERIFICATION_SIGNING_KEYS_JSON` | GENERATED SECRET | Required map of `kid` to canonical base64url signing keys; contains secret key bytes. |
| `ADMIN_MFA_POLICY` | NON-SECRET CONFIG | `DEFERRED_NON_PRODUCTION` or `REQUIRED`; production requires `REQUIRED`. |
| `ADMIN_MFA_ENCRYPTION_KEY` | SECRET | Canonical base64url 32-byte AES-256-GCM key; required only with `REQUIRED` and independent from session/signing keys. |

The API also consumes every object-storage/import/BullMQ variable in section 5.3.

### 5.2 Worker

| Variable | Classification | Current contract / production note |
| --- | --- | --- |
| `NODE_ENV`, `LOG_LEVEL`, `DATABASE_URL`, `DATABASE_MAX_CONNECTIONS`, `REDIS_URL`, `READINESS_TIMEOUT_MS` | As classified in 5.1 | Shared infrastructure contract. |
| `WORKER_HOST`, `WORKER_HEALTH_PORT` | DEPLOYMENT-SPECIFIC | Defaults `0.0.0.0` and `3002`; health must remain private. |
| `PARTICIPANT_IMPORT_CONCURRENCY`, `CERTIFICATE_GENERATION_CONCURRENCY` | NON-SECRET CONFIG | Integers 1–10; default 2 each. |
| `CERTIFICATE_RENDER_MAX_ASSET_BYTES`, `CERTIFICATE_PDF_MAX_BYTES` | NON-SECRET CONFIG | Bounded renderer/storage limits; default 10 MiB each. |
| `VERIFICATION_PUBLIC_BASE_URL` | DEPLOYMENT-SPECIFIC | Required HTTP(S) origin; HTTPS is required in production. |
| `VERIFICATION_SIGNING_KEYS_JSON` | GENERATED SECRET | Required trusted signing-key set. Worker selects the immutable certificate `kid`; it does not consume `VERIFICATION_ACTIVE_KID`. |

The worker also consumes every object-storage/import/BullMQ variable in section 5.3.

### 5.3 API/worker object storage, import, and BullMQ

| Variable | Classification | Current contract / production note |
| --- | --- | --- |
| `OBJECT_STORAGE_ENDPOINT` | DEPLOYMENT-SPECIFIC | Required HTTP(S) endpoint; production HTTPS is not currently enforced. |
| `OBJECT_STORAGE_REGION`, `OBJECT_STORAGE_BUCKET` | DEPLOYMENT-SPECIFIC | Region defaults to `us-east-1`; bucket is required and validated syntactically. |
| `OBJECT_STORAGE_ACCESS_KEY` | SECRET | Credential identifier; handle with the corresponding secret credential. |
| `OBJECT_STORAGE_SECRET_KEY` | SECRET | Required storage credential. |
| `OBJECT_STORAGE_FORCE_PATH_STYLE` | NON-SECRET CONFIG | Boolean; default `true`. Provider-specific. |
| `OBJECT_STORAGE_CREATE_BUCKET` | NON-SECRET CONFIG | Schema default `false`; local Compose default `true`. Must be `false` after production provisioning. |
| `PARTICIPANT_IMPORT_MAX_BYTES`, `PARTICIPANT_IMPORT_MAX_ROWS`, `PARTICIPANT_IMPORT_MAX_UNCOMPRESSED_BYTES` | NON-SECRET CONFIG | Bounded import limits; defaults 5 MiB, 10,000 rows, and 25 MiB. |
| `PARTICIPANT_IMPORT_RETENTION_HOURS` | NON-SECRET CONFIG | Bounded temporary-data retention; default 168 hours. |
| `BULLMQ_PREFIX` | DEPLOYMENT-SPECIFIC | Validated namespace; default `certificate-platform`; must not collide across environments. |

### 5.4 Web

| Variable | Classification | Current contract / production note |
| --- | --- | --- |
| `NEXT_PUBLIC_API_BASE_PATH` | PUBLIC | Browser-safe base path; defaults to `/api`. |
| `API_INTERNAL_BASE_URL` | DEPLOYMENT-SPECIFIC | Server/build-time HTTP(S) origin with no credentials or path; used for the Next.js rewrite. |
| `WEB_PORT` | DEPLOYMENT-SPECIFIC | Compose host publication only; defaults to `3000`. Not read by the Next.js process. |

No database, Redis, object-storage, session, or signing secret belongs in the web
browser configuration.

### 5.5 Local Compose infrastructure controls

These configure local containers and would be mapped to provider/runtime settings in
production rather than copied blindly:

| Variable | Classification | Consumer |
| --- | --- | --- |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PORT` | DEPLOYMENT-SPECIFIC | PostgreSQL container/database naming and local host binding. |
| `POSTGRES_PASSWORD` | SECRET | PostgreSQL container credential. |
| `REDIS_PORT` | DEPLOYMENT-SPECIFIC | Local Redis host binding. |
| `REDIS_PASSWORD` | SECRET | Redis credential and Compose URL interpolation. |
| `MINIO_ROOT_USER` | SECRET | Privileged MinIO credential identifier; production application access must use least privilege instead. |
| `MINIO_ROOT_PASSWORD` | SECRET | Privileged MinIO credential. |
| `MINIO_API_PORT`, `MINIO_CONSOLE_PORT` | DEPLOYMENT-SPECIFIC | Local loopback bindings only. |

Evidence for the complete contract: `.env.example`, `compose.yaml`,
`packages/config/src/environment.ts`, and `apps/web/next.config.ts`.

## 6. Secret classification and handling baseline

| Material | Classification | Required production handling |
| --- | --- | --- |
| Session HMAC material (`SESSION_SECRET`) | GENERATED SECRET | Independently generated high entropy; managed injection; rotation/runbook design in a later part. |
| Verification key bytes (`VERIFICATION_SIGNING_KEYS_JSON`) | GENERATED SECRET | Managed key set, reviewed active/retained keys, protected rotation and compromise procedure. |
| Verification `kid` (`VERIFICATION_ACTIVE_KID`) | NON-SECRET CONFIG | May appear in signed token headers and immutable certificate metadata; never treat it as key material. |
| PostgreSQL/Redis credential-bearing URLs | SECRET | Separate environment credentials, encrypted transport policy, redacted logs, no source control. |
| PostgreSQL/Redis/MinIO passwords | SECRET | Provision through the deployment secret mechanism; local placeholders are prohibited. |
| Object-storage access/secret keys | SECRET | Dedicated least-privilege application identity; do not use a provider root/admin identity. |
| Public/admin origins, public verification URL, internal API URL | DEPLOYMENT-SPECIFIC | Reviewed exact origins/routes; no credentials; production public origins use HTTPS. |
| `NEXT_PUBLIC_API_BASE_PATH` | PUBLIC | The only intentionally browser-exposed runtime configuration currently defined. |

No real production values, `.env.production`, or production secret-generation command
is part of Phase 8.1.

## 7. Production fail-closed audit

| Condition | Current guarantee | Actual gap / disposition | Status |
| --- | --- | --- | --- |
| Missing/malformed session secret | API parsing rejects missing values and values under 32 UTF-8 bytes. Validation errors expose field names, not submitted secret values. | Entropy, known-placeholder, and environment-uniqueness checks are not enforced. Deployment secret controls remain required. | PARTIAL |
| Invalid PostgreSQL URL | Missing/unparseable values and non-`postgres:`/`postgresql:` schemes are rejected before startup. | No production requirement for credentials, TLS parameters, host/database completeness, or disallowing local/development targets. | PARTIAL |
| Invalid Redis URL | Missing/unparseable values and non-`redis:`/`rediss:` schemes are rejected before startup. | Production does not require `rediss:`, authentication, or an environment-specific namespace/database. | PARTIAL |
| Invalid object storage | Endpoint is HTTP(S); bucket, access key, secret-key minimum length, booleans, and limits are validated. API/worker perform `HeadBucket` and fail if the bucket is missing when creation is disabled. | Production HTTPS, least-privilege credentials, private-bucket policy, server-side encryption/versioning, and root-credential rejection are not validated. | PARTIAL |
| Invalid verification key set | JSON must be a non-empty object; `kid` syntax, duplicate/malformed identifiers, canonical base64url encoding, and decoded key length 32–128 bytes are enforced. | Managed lifecycle, per-environment separation, rotation, compromise, and retirement remain operational work. | PARTIAL |
| Active `kid` absent from trusted key set | API validation rejects startup when `VERIFICATION_ACTIVE_KID` is not an own key-set member. | Worker intentionally uses each certificate's immutable stored `kid`; all retained certificate keys must remain in its trusted set or affected generation fails safely. | READY (application contract) |
| HTTP admin origin in production | API validation rejects every non-HTTPS `ADMIN_ALLOWED_ORIGINS` member. | Exact reverse-proxy origin and trusted-hop configuration are not implemented. | READY (configuration contract) |
| HTTP public verification base URL in production | Worker validation rejects non-HTTPS `VERIFICATION_PUBLIC_BASE_URL`. | TLS/reverse proxy and public DNS are not implemented. | READY (configuration contract) |
| Production MFA | API validation rejects production unless policy is `REQUIRED` with a valid dedicated encryption key. | Deployment must provision and protect the key and apply migration `202608310011_admin-mfa`. | READY (application contract) |

Evidence: `packages/config/src/environment.ts:7-190` and
`packages/config/src/environment.test.ts:54-126`.

## 8. Production MFA gate

Phase 8.2 adds the approved application-owned TOTP contract. `ApiEnvironmentSchema`
accepts `DEFERRED_NON_PRODUCTION` and `REQUIRED`, rejects the deferred policy in
production, and requires a strict dedicated 32-byte encryption key whenever MFA is
required. Password success creates no full session until enrollment or TOTP/recovery
verification completes. Replay and one-time recovery consumption are enforced by
atomic PostgreSQL updates. This resolves the application MFA blocker; deployment key
provisioning, migration execution and operational evidence remain Phase 8 deployment work.

## 9. Container and Compose gap audit

### Local development behavior

- PostgreSQL, Redis, and MinIO use pinned images, named volumes, restart policies, and
  health checks. Their ports are published to loopback for local diagnostics.
- Redis AOF is enabled and all three infrastructure services persist in named volumes.
- API and web ports are published to the host; worker health stays inside Compose.
- API/worker wait for healthy PostgreSQL, Redis, and MinIO. Web waits for healthy API.
- `OBJECT_STORAGE_CREATE_BUCKET` defaults to `true` in Compose, allowing local bucket
  creation. The application schema itself defaults it to `false`.
- Migrations are explicit through `pnpm db:migrate` or the `migrate` tools profile;
  application startup does not run migrations.
- All service secrets are passed through environment variables, with local-only
  development placeholders.

### Production requirements and gaps

| Area | Current state | Production requirement |
| --- | --- | --- |
| Ingress | API/web publish direct host ports; no proxy/TLS | Bind upstreams privately and expose only the reviewed TLS proxy. |
| Images | Each target inherits the full workspace, source tree, package manager, and installed development graph | Create reviewed production build/runtime stages with minimal runtime contents and reproducible provenance. |
| User | Dockerfile has no `USER`; Node processes run as image default root | Run application containers as a dedicated non-root user; validate writable paths. |
| Filesystem/resources | No read-only root filesystem, tmpfs policy, CPU/memory/PID limit, or renderer time/process isolation | Apply service limits and isolate renderer execution consistent with `docs/20-deployment.md`. |
| Networks | `internal` prevents external routing for worker/infrastructure, but API/web also share an `edge` network and no real edge service exists | Define least-privilege production networks and explicit proxy upstream connectivity. |
| Health | HTTP liveness/readiness and container health checks exist | Add external monitoring; readiness must also prove required schema/version and object-storage/queue expectations as designed. |
| Dependencies | Compose health dependencies exist | Do not treat startup ordering as migration or long-term dependency assurance. |
| Migrations | Explicit one-shot target exists | Define pre-deploy lock, compatibility/rollback, success verification, and operator procedure. Current readiness only runs `SELECT 1`, not a schema-version check. |
| Bucket creation | Local default creates missing bucket | Provision bucket/policy out of band; production uses `OBJECT_STORAGE_CREATE_BUCKET=false`. |
| Secrets | Environment interpolation only | Select an approved managed injection mechanism; separate app and administrative identities. |
| Persistence | Named volumes for PostgreSQL/Redis/MinIO | Define production storage classes, capacity, backup, restore, encryption, ownership, and lifecycle. |
| Rollback | No procedure | Define image/config/database compatibility and rollback decision/runbook. |

The Dockerfile's absence of `USER` and its shared `workspace` ancestry are observable
facts, not a claim that the existing images are unsafe for local development.

## 10. Persistent-data inventory

| Data class | Current owner/location | Classification | Reason / requirement |
| --- | --- | --- | --- |
| PostgreSQL application data | PostgreSQL named volume locally | MUST BACK UP | Authoritative tenant, identity, certificate, immutable issuance, job/outbox, and audit state. |
| Certificate PDFs | Private object storage | MUST BACK UP | Live download object tied to stored hash/length/MIME and generation revision; loss is a service/data-integrity incident even when immutable inputs may permit controlled regeneration. |
| Template image/font assets | Private object storage + PostgreSQL metadata | MUST BACK UP | Published/archived template inputs are immutable and historical rendering depends on exact bytes. |
| Participant-import source objects | Private object storage | RETENTION-BOUNDED | Temporary validation input; deletion is reconciled after staging or terminal failure and retention defaults to 168 hours. Do not extend retention through ordinary backups without policy. |
| Participant-import staged rows | PostgreSQL | RETENTION-BOUNDED | Temporary confirmation data; cleaned after success/expiry according to the import policy. Included incidentally in database recovery within the approved retention window. |
| Redis sessions and rate-limit counters | Redis/AOF locally | EPHEMERAL | Loss logs users out and resets counters; not authoritative business data. Recovery behavior must be accepted/tested. |
| BullMQ queue state | Redis/AOF plus PostgreSQL job/outbox authority | RECONSTRUCTABLE | Redis transports work; PostgreSQL job/item/outbox state drives reconciliation. Restore/replay must be tested to avoid duplicate or lost work. |
| Storage-cleanup/outbox intent | PostgreSQL | MUST BACK UP | Durable recovery state protecting database/object-storage consistency. |
| Service logs | Structured stdout/stderr; no repository-managed persistence | RETENTION-BOUNDED | Production log sink, security/audit retention, access, and deletion policy are not implemented. |

Backup jobs, storage versioning changes, and restore drills belong to Phase 8.4.

## 11. Observability baseline

### Present

- Shared structured Pino JSON logging with configurable level and explicit redaction of
  authorization/cookie/CSRF/password/token/signing-key/storage-key fields.
- Error serialization retains only a bounded error type; message and stack content are
  redacted.
- API and worker generate server-owned UUID request IDs, ignore client request IDs as
  identity, and return `X-Request-ID`.
- API and worker expose `/health/live` without dependency work.
- API and worker expose `/health/ready`; PostgreSQL `SELECT 1` and Redis `PING` must both
  succeed inside a bounded timeout.
- API/worker startup connects to Redis and verifies the private storage bucket; worker
  startup also initializes its processors and reconciliation loops before listening.
- Security/audit events are append-only/allowlisted in PostgreSQL for implemented
  authentication, authorization, and domain actions.
- Worker reconciliation paths emit warnings for queue dispatch and storage cleanup
  failures without intentionally logging object keys or job payload PII.

### Missing production capabilities

- Central service log collection, retention, access control, clock synchronization,
  correlation/runbook conventions, and alerts.
- External liveness/readiness monitoring and an operator-visible deployment/version
  marker.
- PostgreSQL availability, connection saturation, storage/capacity, replication/backup
  freshness, and migration monitoring.
- Redis availability, memory/eviction/persistence health, and authentication/TLS
  monitoring.
- BullMQ queue depth, age, stalled/retried/dead-letter work, outbox lag, and worker
  failure/concurrency monitoring reconciled with PostgreSQL job state.
- Object-storage availability, capacity/quota, versioning/retention, integrity errors,
  and cleanup backlog monitoring.
- Host/container CPU, memory, disk, inode, restart, and certificate-expiry monitoring.
- Backup success/freshness/capacity alerts and restore-test evidence.
- Defined service-level objectives, alert ownership/escalation, incident response, and
  audit/log retention policy.

Phase 8.1 does not select Prometheus, Grafana, Sentry, or another monitoring vendor.

## 12. Deployment blocker matrix

Statuses are limited to `READY`, `PARTIAL`, `BLOCKED`, and `NOT_IMPLEMENTED`.

| Requirement | Current state | Evidence | Production blocker? | Target Phase 8 part |
| --- | --- | --- | --- | --- |
| Production MFA | `READY (application contract)`: production requires TOTP MFA and a dedicated encryption key | config/auth/API/database focused tests and migration `202608310011_admin-mfa` | Yes | 8.2 complete |
| TLS | `NOT_IMPLEMENTED`: HTTPS is required by config contracts but no termination exists | environment production refinements; `docs/20-deployment.md` | Yes | 8.3 |
| Reverse proxy / trusted hops | `NOT_IMPLEMENTED`: no edge service; Fastify `trustProxy` remains unset | `compose.yaml`; `apps/api/src/app.ts`; `docs/16-threat-model.md` | Yes | 8.3 |
| Public URL/origins | `PARTIAL`: exact/HTTPS validation exists; production DNS/origins are unselected | `packages/config/src/environment.ts:97-117,159-189` | Yes | 8.3 |
| Secrets | `PARTIAL`: typed required values and redaction exist; managed injection/rotation does not | config schema, logger, `.gitignore`, `.dockerignore` | Yes | 8.3 |
| Signing keys | `PARTIAL`: strict set/active-kid validation and immutable certificate `kid` exist; operational key lifecycle does not | config schema/tests; migration `202608250008_*`; token spec | Yes | 8.3/8.5 |
| PostgreSQL persistence | `PARTIAL`: authoritative design and local named volume exist; production durable storage/HA/capacity are undefined | database docs; `compose.yaml` | Yes | 8.3 |
| Redis | `PARTIAL`: authenticated local AOF, readiness, and reconciliation design exist; production TLS/persistence/eviction policy is undefined | `compose.yaml`; queue connection code | Yes | 8.3 |
| Object storage | `PARTIAL`: private adapter, integrity metadata, local named volume, and missing-bucket fail-closed mode exist; production policy/versioning/encryption is undefined | storage adapter; `compose.yaml`; deployment doc | Yes | 8.3/8.4 |
| Migration procedure | `PARTIAL`: explicit append-only command and one-shot Compose target exist; deploy lock/compatibility/rollback/runbook do not | database package; `compose.yaml`; CI | Yes | 8.3/8.5 |
| Backup | `NOT_IMPLEMENTED`: requirements exist, no production job or monitoring | `docs/20-deployment.md:85-95` | Yes | 8.4 |
| Restore | `NOT_IMPLEMENTED`: no production restore drill/evidence | testing/deployment docs | Yes | 8.4 |
| Logging | `PARTIAL`: structured/redacted process logs exist; central collection/retention/alerts do not | `packages/config/src/logging.ts`; observability doc | Yes | 8.3 |
| Health monitoring | `PARTIAL`: API/worker liveness and DB/Redis readiness exist; no external monitor or storage/schema/queue visibility | health route/app; database/queue checks | Yes | 8.3 |
| Queue/worker | `PARTIAL`: durable outbox, BullMQ worker, reconciliation, private health, and restart policy exist; production backlog/failure monitoring and resource isolation do not | worker server; `compose.yaml`; integration tests | Yes | 8.3 |
| Deployment rollback | `NOT_IMPLEMENTED`: no image/config/schema rollback contract or runbook | repository/runbook audit | Yes | 8.5 |
| Production validation | `PARTIAL`: CI quality/integration/Compose/image gates exist; no production-like smoke, TLS, secret, migration, rollback, or restored-data rehearsal | `.github/workflows/ci.yml` | Yes | 8.5 |

The matrix deliberately does not claim production readiness merely because application
tests or local Compose checks pass.

## 13. Proposed Phase 8 sub-parts

### Phase 8.1 — Production Readiness Baseline

Inventory current topology, configuration/secrets, fail-closed behavior, persistence,
observability, containers, and blockers. Deliver this document only.

### Phase 8.2 — Production Authentication / MFA Gate

Approve the MFA ADR, schema, API and recovery/enrollment contract; implement and test
the factor lifecycle and production policy; preserve session, CSRF, origin,
enumeration, tenant, and audit guarantees. Completion must remove the startup blocker
only through the approved tested contract.

### Phase 8.3 — Production Runtime Deployment + Observability

Implement production runtime images/configuration, non-root/resource/filesystem
controls, private networks, explicit migration execution, managed secret injection,
TLS/reverse proxy with narrowly trusted hops, production storage/database/Redis
policies, service logging, health monitoring, queue/backlog monitoring, and operator
runbooks. No real infrastructure is configured by Phase 8.1.

### Phase 8.4 — Backup + Restore Drill

Implement PostgreSQL and object-storage backup/lifecycle controls, monitoring and
retention; document Redis/queue recovery; execute an isolated restore drill proving
certificate/template/PDF integrity and revocation state.

### Phase 8.5 — Production Rehearsal + Documentation + Completion Gate

Run a production-like deployment rehearsal, migrations, smoke/security validation,
failure/rollback exercises, key/config validation, restored-data verification, and
complete operator/incident documentation. Only this evidence can close Phase 8.

## 14. Explicitly out of scope for Phase 8.1

- MFA schema, enrollment, challenge, recovery, UI, policy, or startup-gate changes.
- TLS certificates, reverse proxy, trusted-proxy configuration, DNS, firewall, VPS, or
  cloud/provider changes.
- Real production secrets, secret generation, `.env.production`, or secret-manager
  selection/configuration.
- Production Docker/Compose behavior, image hardening, process isolation, or network
  changes.
- Backup jobs, retention mutation, restore execution, or disaster-recovery drills.
- Metrics/tracing/error-reporting vendor selection or observability tooling.
- External deployment, production migration, public traffic, or readiness claim.

## 15. Phase 8.1 completion criteria

Phase 8.1 is complete when:

- canonical architecture/deployment/observability documentation and actual source are
  reconciled;
- the topology and public/private exposure requirements are explicit;
- all API, worker, web, infrastructure, object-storage, BullMQ, and verification-key
  configuration is inventoried and classified without real credentials;
- current fail-closed guarantees and gaps are distinguished;
- the production MFA gate is source/test-backed and remains unchanged;
- local Compose behavior is separated from production requirements;
- every durable/ephemeral/retention-bounded data class is accounted for;
- present and missing observability capabilities are recorded;
- the deployment blocker matrix assigns remaining work to Parts 8.2–8.5;
- required repository validation passes; and
- the documentation-only change is committed, pushed, and attached to the single Draft
  Phase 8 PR.

Meeting these criteria means **Phase 8.1 is complete**. It does not mean the platform
is ready for production and does not authorize Phase 8.2 work.

## 16. Phase 8.3 implementation record

This section supersedes only the Phase 8.3 gap statements above. It records repository
implementation, not an external production deployment, certificate issuance, backup,
restore drill, or rehearsal. PR Part 3 remains unchecked pending the required review
and evidence gates; Parts 4 and 5 remain out of scope.

### Runtime, topology and ingress

- `Dockerfile` now has frozen-lockfile Node 24.19.0/pnpm 11.5.2 build stages, Next.js
  standalone output, production dependency deployment for API/worker, non-root
  runtime UID/GID 10001, and an explicit `migrate` target.
- `compose.production.yaml` is a distinct production definition. It includes only
  Nginx, web, API, worker and a one-shot tools-profile migration service. PostgreSQL,
  Redis, and S3-compatible storage are externally provisioned private dependencies;
  their production data/admin ports and any provider consoles are not in this Compose
  definition.
- Only Nginx publishes `80:8080` and `443:8443`. HTTP redirects to HTTPS. Nginx sends
  all permitted paths to Next.js; the existing Next.js `/api/*` rewrite is the only
  Fastify path. Nginx blocks public health, metrics and OpenAPI paths.
- API attaches only to application and dependency networks; worker/migration attach
  only to the dependency network; web attaches only to the application network. The
  external dependency network name is operator-required. No Docker socket, privileged
  container or host port is configured for internal services.
- Nginx uses externally injected Docker TLS secrets, overwrites forwarded headers and
  clears client request IDs. API production configuration requires exactly one trusted
  proxy hop and continues to generate request IDs itself. The selected Nginx decision
  is recorded in ADR-020.

### Runtime hardening and migration boundary

All long-running production services have a read-only filesystem, non-root user,
`cap_drop: ALL`, `no-new-privileges`, bounded tmpfs, PID/CPU/memory limits, restart
policy and graceful `SIGTERM`/`SIGINT` closure. Application processes have no runtime
package manager or source workspace in their final image where practical. Web receives
no data-service secrets; worker receives no API session/MFA secrets. The worker is
resource-limited as a process, but its renderer remains in-process; no stronger
renderer isolation is claimed.

Migrations are not part of web/API/worker startup. The explicit tools-profile target
runs `node-pg-migrate` with `--advisory-lock-mode fail`; migration lock contention is
therefore an observable failure. The approved order is secret/config injection,
private dependency verification, explicit compatible migration, successful migration
observation, application rollout, and private readiness/metric verification. Applied
historical migrations are never rolled back; image rollback requires backward schema
compatibility or a forward corrective migration.

### Fail-closed configuration and secrets

Production parsing now rejects loopback/credentialless/non-TLS PostgreSQL,
non-`rediss:`/unauthenticated Redis, HTTP object storage, automatic bucket creation,
the default BullMQ namespace, documented local session/signing/MFA/storage
placeholders, non-HTTPS admin/public origins, and any production MFA policy other than
`REQUIRED`. PostgreSQL accepts `sslmode=require`, `verify-ca`, or `verify-full`; actual
CA/DNS verification policy is provider-side operational evidence. Object-storage
credentials must be a dedicated least-privilege application identity; bucket
provisioning, privacy policy, server-side encryption/versioning and credentials
rotation are deliberately operational responsibilities rather than fake application
checks.

### Health, logs and metrics

API and worker distinguish dependency-free liveness from bounded dependency readiness.
Readiness checks PostgreSQL and Redis only, return generic error data, avoid topology/
credential/queue details, and feed private container health checks. Both services
provide private `/metrics`; the edge blocks it. The implemented low-cardinality
metrics cover HTTP count/latency/error outcomes, verification/download outcomes,
rate-limit events, database/Redis readiness and failures, Redis session failures,
generation queue depth/duration, failed/retried/stalled generation events, renderer
failures and object-storage failures. API/worker request completion logs are structured
JSON with service/request ID/route/status/duration/stable error code, and Nginx emits a
sanitized JSON edge record. Sensitive data and PII listed in `docs/21-observability.md`
remain redacted/excluded.

### Operations and remaining blockers

`docs/20-deployment.md` contains concise runbooks for elevated 5xx, database,
Redis/session, queue, generation, storage, tampering and brute-force signals, together
with safe diagnostic/recovery boundaries. It also describes production startup,
migration, health, secret injection, private-only interfaces, logs/metrics and rollback
limits.

Phase 8.4 remains blocked on authorized backup/retention/versioning implementation and
an isolated restore drill. Phase 8.5 remains blocked on a real production-like
rehearsal: deployment-injected DNS/TLS/secrets/provider access, private smoke tests,
migration/rollback exercise, alert routing/ownership, and restored-data verification.
This Phase 8.3 code/documentation implementation does not claim those external
operational controls have occurred.

Evidence: `Dockerfile`, `compose.production.yaml`, `deploy/nginx/nginx.conf`,
`packages/config/src/environment.ts`, `packages/config/src/metrics.ts`,
`apps/api/src/app.ts`, `apps/worker/src/server.ts`, and focused configuration,
health/metrics, storage, queue and Compose tests.
