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

The PDF renderer runs in an isolated worker boundary with outbound network disabled by default, a read-only application filesystem, a dedicated temporary directory and explicit CPU/memory/time limits. It may load only validated template definitions, approved private assets and bundled fonts.

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

## Public edge policy

- Do not log request bodies for public verification or download routes.
- Strip or redact verification/download tokens before tracing and error reporting.
- Set `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow, noarchive` on public API responses.
- Set `Referrer-Policy: no-referrer` on the public verification page.
- Do not put token values in paths or query strings.
- Preserve the application-issued request ID without trusting a client value as identity.
