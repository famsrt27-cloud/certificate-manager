# 01 — System Architecture

## Status

This document records the approved architecture boundaries. The canonical implementation stack is locked in `docs/03-technology-stack.md`, and the planned pnpm workspace is locked in `docs/04-repository-layout-and-naming.md`.

## Architecture style

The platform is composed of independently deployable web, API and worker responsibilities backed by shared infrastructure:

```text
Internet
  |
WAF / reverse proxy
  |-----------------------------|
Next.js Admin UI             Next.js Public UI
  |                             |
      Fastify Admin API / Public Verification API
  |                             |
  |---------- Application Services ---------|
                    |
       PostgreSQL 16 + Redis / BullMQ
                    |
          TypeScript BullMQ Worker
                    |
        PDFKit + qrcode Renderer
                    |
 S3-compatible Private Storage / MinIO
```

The logical boundaries are implemented as a pnpm monorepo with separate Next.js web, Fastify API and BullMQ worker processes. They must not be collapsed in a way that creates a parallel Next.js backend, moves bulk generation into an HTTP request or allows the renderer unrestricted resource access.

## Implementation boundaries

- `apps/web` owns browser UI and imports only browser-safe shared contracts.
- `apps/api` owns all canonical `/api/admin/*` and `/api/public/*` routes.
- `apps/worker` owns BullMQ processors and PDF generation.
- `packages/domain` owns framework-independent policy/use cases.
- `packages/database` owns Kysely access and node-pg-migrate migrations.
- `packages/auth` owns bcrypt, Redis session and CSRF services.
- `packages/contracts` owns browser-safe Zod wire schemas.
- `packages/template-engine` owns custom JSON validation and safe binding.
- `packages/certificate-renderer` owns PDFKit/qrcode rendering.
- `packages/storage` owns S3-compatible access through `@aws-sdk/client-s3`.
- `packages/queue` owns BullMQ queue names and versioned payload schemas.

Applications depend on shared packages; shared packages never import application entrypoints. PostgreSQL remains authoritative for certificate/job state even though Redis/BullMQ coordinates execution.

## Trust boundaries

### Admin boundary

- All `/api/admin/*` endpoints require authentication.
- Authentication uses an opaque Redis-backed server-side session and session-bound CSRF protection for state-changing requests.
- Authorization and organization scope are enforced on the backend for every request.
- Internal UUIDs may be used inside authenticated admin contracts but never as authorization by themselves.
- Sensitive state changes create sanitized audit events.

### Public boundary

- `/api/public/*` does not require a recipient account.
- Possession of a valid signed verification token permits verification of the referenced certificate only.
- The public token contains a separate opaque public certificate identifier, never the internal certificate UUID.
- Every verification and download checks current certificate state in PostgreSQL.
- Public endpoints use distributed rate limiting, generic failure responses and minimal disclosure.

### Worker and renderer boundary

- Import and certificate generation run as bounded, retryable background jobs.
- BullMQ/Redis coordinates delivery while PostgreSQL job/item rows remain durable state and idempotency authority.
- Workers are idempotent and use explicit job/item state.
- Custom JSON template definitions are validated with Zod and resolved by an allowlisted data binder; they are not executable code.
- PDFKit/qrcode rendering runs with no remote-resource loading and with CPU, memory, time and temporary-filesystem limits.
- Only validated, private, internally addressed assets may be loaded.

### Storage boundary

- Certificate PDFs, participant import files and template assets use S3-compatible private storage through `@aws-sdk/client-s3`; MinIO supplies the Docker Compose development service.
- Storage keys never appear in public API responses.
- Public downloads use a short-lived, certificate-scoped authorization that is redeemed through the application.
- Certificate status is rechecked when download authorization is issued and when it is redeemed.

## Data ownership and tenancy

- Organizations are the tenant boundary.
- Every tenant-owned row carries `organization_id`.
- Composite foreign keys bind related rows to the same organization.
- A user receives organization access through an organization membership and organization-scoped roles.
- `SUPER_ADMIN` is a system role and is not represented as an organization membership role.
- Public certificate resolution uses a globally unique opaque public identifier and does not bypass certificate-state checks.

## Source-of-truth documents

- Product scope: `docs/00-project-overview.md`
- Security and privacy: `docs/02-security-privacy.md`
- Implementation stack: `docs/03-technology-stack.md`
- Repository layout and naming: `docs/04-repository-layout-and-naming.md`
- Database rules: `docs/05-database-design.md`
- Testing strategy: `docs/07-testing-strategy.md`
- ERD: `docs/08-erd.md`
- PostgreSQL reference schema: `docs/09-postgresql-schema.sql`
- API contract: `docs/10-api-contract.md`
- Token format: `docs/11-token-spec.md`
- Architecture decisions: `docs/24-adr.md`

When two documents differ, the more specific source-of-truth document above governs. Any contract change must update all affected documents and add or amend an ADR.
