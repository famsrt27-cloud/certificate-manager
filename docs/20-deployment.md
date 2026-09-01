# 20 — Deployment Architecture

## Locked Docker Compose baseline

```text
                    Internet
                       |
                    DNS/CDN
                       |
                    WAF/Proxy
                       |
                +------+------+
                |             |
             Next.js     Fastify API
                |             |
                +------+------+
                       |
          +------------+-------------+
          |            |             |
    PostgreSQL 16    Redis       S3 / MinIO
          |
       Backups

Fastify → BullMQ/Redis → TypeScript Worker → PDFKit/qrcode → S3-compatible storage
```

## Compose services

Required services:
- web
- api
- worker
- postgres
- redis
- minio

In staging/production, only the intended web/API edge is public. Route browser `/api/*` traffic to Fastify under the same first-party site as the Next.js application so the host-only session cookie and CSRF policy remain coherent. A separate cross-site deployment requires a security/ADR review.

Do not publish PostgreSQL, Redis or MinIO administrative/data ports in staging or production. Local development may bind required diagnostics to loopback only; it must not make buckets or infrastructure services publicly reachable.

Service responsibilities:

- `web`: Next.js/Tailwind UI; no database, Redis or S3 credentials
- `api`: Fastify routes, Kysely access, bcrypt/session/CSRF services, BullMQ producers and S3 adapter
- `worker`: BullMQ processors, Kysely state transitions, custom template engine, PDFKit/qrcode and S3 adapter
- `postgres`: PostgreSQL 16 durable application state
- `redis`: server-side sessions, distributed rate limiting and BullMQ coordination with separated key namespaces
- `minio`: local/Compose S3-compatible private object storage

Compose definitions use health checks and dependency readiness; container start order alone is not readiness. API/worker failures must not cause migrations to run concurrently without an explicit migration lock/command.

The certificate renderer has a capability-minimized package boundary: it receives only
validated immutable rendering data, a prepared verification URL and approved asset
bytes. It currently runs in the trusted worker process. Production container controls
limit the worker as a whole, but do **not** claim independent renderer process or
network isolation; an in-process renderer compromise can still use the worker's
process privileges. It may load only validated template definitions, approved private
assets and bundled fonts.

## Environment separation

- local
- staging
- production

Separate:
- databases
- Redis namespaces/credentials
- storage buckets
- secrets
- signing keys
- session and CSRF secrets

## Production secrets

Use a secret manager or secure environment injection.

Never commit:
- DB password
- signing key
- session/authentication secret
- verification/download token signing secret
- cloud credentials

The root `compose.yaml` is created in Phase 1. It must use environment injection and named volumes, contain no real secrets, and pin reviewed image versions. `.env.example` contains safe placeholders only.

The Phase 1 development baseline pins PostgreSQL `16.12-alpine`, Redis `8.2.3-alpine` and MinIO `RELEASE.2025-09-07T16-13-09Z`. PostgreSQL, Redis and MinIO bind to loopback only. The worker health port remains internal to Compose and is used by its container healthcheck. Apply migrations explicitly with `pnpm db:migrate` or the `migrate` Compose tools profile; application startup never runs migrations implicitly.

Phase 2 API configuration requires an independently generated `SESSION_SECRET` of at least 32 UTF-8 bytes, exact `ADMIN_ALLOWED_ORIGINS`, session idle/absolute TTLs, bcrypt cost and login-rate limits. `API_INTERNAL_BASE_URL` is a server-only HTTP origin used by the Next.js rewrite to proxy same-origin `/api/*` requests to the canonical Fastify API; it cannot contain credentials or a path. Development Compose placeholders are not production secrets. Production API startup requires `ADMIN_MFA_POLICY=REQUIRED` and an independently generated, canonical base64url-encoded 32-byte `ADMIN_MFA_ENCRYPTION_KEY`; the MFA key must be managed and rotated separately from session and verification-signing keys. `DEFERRED_NON_PRODUCTION` remains available only outside production.

## Backups

Test restoration, not just backup creation.

Minimum:
- automated database backups
- object storage versioning where supported
- documented restore procedure
- Redis is not the source of truth for certificates/jobs, but session loss and queue-recovery behavior must be documented and tested

Restores must preserve certificate-to-template-version links, immutable template assets, public certificate identifiers, certificate state and PDF integrity metadata.

## Phase 8.4 backup and isolated restore operation

PostgreSQL is the authoritative recovery source for tenant, certificate, immutable issuance/template relationships, audit history, PostgreSQL queue/outbox state and storage-cleanup intent. Certificate PDFs and immutable template image/font objects are also durable recovery data. Participant-import source objects and staged rows remain retention-bounded; ordinary durable-object backup manifests deliberately exclude import objects. Redis sessions and rate-limit counters are ephemeral: loss invalidates sessions safely and resets limits. BullMQ Redis state is reconstructable only; PostgreSQL job/outbox state and the existing reconciler are authoritative.

`ops/backup/backup-postgres.ps1` is the explicit operator command. It runs a PostgreSQL-16-compatible `pg_dump` custom-format logical backup into an operator-selected directory and writes only result, timestamp and safe byte size to `backup-status.json`. It neither prints the supplied connection URL nor embeds credentials. Operators inject credentials using their approved runtime method (for example a protected `PGPASSFILE`). A non-zero result fails the command. `ops/backup/restore-postgres.ps1` requires an explicit target URL and dump path, refuses obvious production host/database names, and intentionally has no default, `--clean`, or `--create` behavior; it is for an authorized, empty isolated database only.

The production bucket remains private. Provider controls must require S3-compatible versioning where supported, server-side encryption and encrypted transport, plus a separately injected backup identity restricted to durable-object source and approved backup target. The application identity stays least privilege. Provider lifecycle/replication/versioning cannot be truthfully enforced in application code; deployment approval must retain evidence that certificate/template versions cannot expire before the approved backup-retention window. Import prefixes retain their bounded lifecycle and are not copied by the durable manifest.

`ops/backup/object-copy.mjs` copies an operator-approved durable object manifest between pre-provisioned private S3-compatible buckets, accepts only `certificate_pdf` objects under `certificates/` and `template_asset` objects under `template-assets/`, verifies source SHA-256/length before copying, and retains hash metadata. It rejects participant-import and other non-durable namespaces. Production operation does not request bucket-creation authority; the explicit `--create-target-bucket` switch is reserved for the isolated local drill. Manifests are protected backup artifacts, never repository files. Schedule/frequency, retention duration, RPO/RTO and restore authority remain operator/business decisions required before launch. Policy must define encryption at rest, encrypted transport, off-site/provider durability, backup/restore access audit, expiry/deletion authorization, and secure deletion. Monitor safe backup status timestamp/size, provider versioning/lifecycle/replication state, and restore-drill status/timestamp without tenant identifiers, object keys, credentials or PII in signals.

`ops/backup/restore-drill.ps1` uses `compose.restore-drill.yaml`, with dedicated PostgreSQL ports/volumes and three isolated MinIO targets. It migrates and seeds only synthetic data, copies durable objects source-to-backup, creates a PostgreSQL dump, stops the original source database/bucket, restores into fresh targets, copies objects from backup, and verifies tenant ownership, public identifier, revocation, immutable issuance/template/generation links, template asset/PDF key/hash/size/MIME, historical signing `kid`, tenant-bound revocation audit, storage-cleanup intent, and queue-outbox recovery state. It does not replay Redis sessions or limits. PostgreSQL outbox reconciliation re-arms only stale non-terminal participant-import or certificate-generation work after lost Redis delivery; terminal/completed work is not requeued, deterministic BullMQ job IDs suppress duplicate transport, and the existing certificate generation revision/state checks preserve issuance idempotency.

Run only with local Docker available: `powershell -ExecutionPolicy Bypass -File .\ops\backup\restore-drill.ps1`. Dedicated volumes are removed on completion/failure. Ignored synthetic artifacts remain for evidence and must be securely removed by the operator after capture.

## Public edge policy

- Do not log request bodies for public verification or download routes.
- Strip or redact verification/download tokens before tracing and error reporting.
- Set `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow, noarchive` on public API responses.
- Set `Referrer-Policy: no-referrer` on the public verification page.
- Do not put token values in paths or query strings.
- Preserve the application-issued request ID without trusting a client value as identity.

## Phase 8.3 production Compose deployment

`compose.production.yaml` is intentionally separate from local `compose.yaml`. It
does not define PostgreSQL, Redis, or object storage. Production operators provision
those private dependencies and attach them through the required external
`PRODUCTION_DEPENDENCY_NETWORK`; this prevents inherited development ports, MinIO
root credentials, local transport, named volumes, and automatic bucket creation.

```text
Internet
  -> nginx TLS edge (ports 80 redirect and 443 HTTPS only)
  -> Next.js web (private application network)
  -> same-site /api/* Next.js rewrite
  -> Fastify API (private application + dependency networks)

worker and explicit migrate tool -> private dependency network only
dependency network -> externally provisioned PostgreSQL, Redis and private S3 storage
```

Nginx is the selected small ingress component. It is limited to TLS termination,
HTTP-to-HTTPS redirect, security response headers, and a single upstream route to
Next.js. Next.js remains the only route to Fastify through its existing same-site
`/api/*` rewrite. The edge blocks public `/health/*`, `/metrics`, and `/openapi.json`.
It overwrites forwarded headers, clears client-supplied request IDs, and Fastify trusts
exactly one private proxy hop (`API_TRUST_PROXY_HOPS=1`); Fastify continues to generate
the canonical request ID.

TLS certificate and private-key Docker secrets are external deployment-injected
objects. DNS names, certificates, private keys, firewall rules, provider CA bundles,
and the secret-store implementation are operational inputs and are not committed.

All application runtime services use the pinned Node 24.19.0 Alpine image, frozen
pnpm 11.5.2 installation, explicit commands, a dedicated UID/GID 10001, read-only
root filesystem, capability drop, `no-new-privileges`, bounded tmpfs, PID/CPU/memory
limits, and restart policy. The proxy has the equivalent controls with its non-root
Nginx user. No service uses a privileged container or Docker socket. API has only the
application/dependency networks; worker has only the dependency network; web has no
data-service credentials. The migration tool has only the database URL and runs only
under the `tools` profile.

### Configuration and secrets

Production application parsing fails closed for the controls it can verify:

- PostgreSQL must be non-loopback, credentialed, name a database, and use
  `sslmode=require`, `verify-ca`, or `verify-full`.
- Redis must be non-loopback, authenticated `rediss:`; each production environment
  requires a non-default BullMQ prefix.
- Object storage must use HTTPS, use an application least-privilege identity rather
  than documented local/admin credentials, and set `OBJECT_STORAGE_CREATE_BUCKET=false`.
- API configuration requires exact HTTPS admin origins, `ADMIN_MFA_POLICY=REQUIRED`, a
  valid non-placeholder MFA encryption key, a non-placeholder session secret, and
  non-placeholder verification signing keys.
- Worker configuration requires its own HTTPS public verification origin and its
  retained verification signing keys, but receives no API session or MFA secret.

Provider-side authorization scope, private bucket policy, server-side encryption,
versioning, certificate-chain verification, DNS ownership, ingress firewalling, and
credential rotation cannot be proven by process configuration alone. Operators must
enforce and evidence those controls before deployment. `OBJECT_STORAGE_CREATE_BUCKET`
never provisions a production bucket.

### Migration and rollout boundary

Migrations are an explicit, observable one-shot command:

```powershell
docker compose --env-file <managed-injected-env-file> -f compose.production.yaml --profile tools run --rm migrate
```

The migration target calls `node-pg-migrate` with `--advisory-lock-mode fail`. A held
lock is visible as a failed operator command; normal API, web and worker startup never
runs migrations. Before a release, deploy the compatible migration, observe a zero
exit status and migration log, then start or roll the application images and verify
private readiness. Roll back application images/configuration only while the completed
schema migration is backward compatible. Never roll back or edit an applied historical
migration; an incompatible schema requires a forward corrective migration. Backup and
restore evidence remains Phase 8.4.

### Private health and metrics

API and worker `/health/live` are process liveness only. `/health/ready` runs bounded
PostgreSQL and Redis checks and returns a generic status without credentials, topology,
database detail, queue contents, or stack traces. Their container health checks use
the private readiness endpoints. `/metrics` is a private Prometheus text endpoint on
the same private networks and is explicitly blocked at Nginx; an operator collector
must be attached privately. No public metrics, health, or worker/operator port exists.

### Operator runbooks

Use request IDs and aggregate metrics/logs; never paste tokens, cookies, CSRF values,
MFA data, credentials, recipient names, request bodies, or object keys into tickets or
chat. Access logs and metrics only through the private operations path.

| Incident | Observable signal | First diagnostic action | Safe recovery / escalation |
| --- | --- | --- | --- |
| Elevated 5xx | edge/API 5xx rate and `certificate_platform_http_requests_total` | Filter structured API logs by stable `error_code` and request ID; check private `/health/ready`. | Halt rollout if correlated with a new image/config; scale or roll back only within the schema compatibility boundary; escalate with redacted request IDs. |
| DB connectivity | readiness failure or `certificate_platform_dependency_failures_total{dependency="database"}` | Check provider status, connection pool saturation and the injected DB URL/TLS material without displaying credentials. | Restore private DB connectivity; keep API unready, do not bypass TLS or change schema history. |
| Redis/session failure | readiness failure, session 503s, or `certificate_platform_redis_session_failures_total` | Check Redis TLS/auth availability and evictions privately; expect no session identifiers in logs. | Repair Redis; communicate possible login loss only after approval; never disable CSRF/session checks. |
| Queue backlog | `certificate_platform_generation_queue_depth` rising by state | Check worker readiness, queue metrics refresh warnings and PostgreSQL job/outbox state without inspecting payload PII. | Add bounded worker capacity or pause new generation according to incident command; preserve the BullMQ prefix and durable job state. |
| Stalled/retried/failed jobs | `certificate_platform_generation_job_events_total` | Filter worker logs by stable error code and job aggregate counts, not queue payload. | Let bounded retry/reconciliation run; investigate terminal items using authorized admin tooling and create a reviewed recovery action. |
| Certificate generation failures | generation failure/duration metrics or renderer failures | Check `certificate_platform_renderer_failures_total`, worker resources and sanitized renderer error codes. | Stop unsafe rollout, preserve immutable issuance/template inputs, and escalate; do not claim the renderer is separately sandboxed. |
| Object-storage failure | `certificate_platform_object_storage_failures_total` or startup bucket failure | Check private provider health, least-privilege policy and bucket existence without exposing access keys/object keys. | Repair private storage policy/connectivity; do not enable automatic bucket creation or public access. |
| Repeated token tampering | verification/download failures rising without corresponding success | Review aggregate result metrics and redacted public-route logs; never retain submitted token values. | Tighten incident/WAF observation under change control and assess signing-key compromise separately; preserve generic public responses. |
| Auth brute-force/rate-limit spike | `certificate_platform_rate_limit_events_total{scope="login"}` | Correlate aggregate rate-limit counts and audit categories; do not collect raw IPs or emails. | Keep throttles enabled, use approved edge controls, and escalate suspected account attack without weakening generic failures. |
