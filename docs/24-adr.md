# 24 — Architecture Decision Records

## ADR-001: Stateless Verification Token

Status: Accepted

Decision:
Use a signed stateless token and do not store the complete token in the certificate table. The token carries `pcid`, a separate opaque public certificate identifier generated from 128 bits of cryptographically secure randomness. It never carries the internal certificate UUID.

Reason:
- reduces secret storage
- supports simple public verification
- QR URL remains stable
- token integrity can be cryptographically verified

Trade-off:
Certificate state still requires database lookup for revocation.

## ADR-002: Template Versioning

Status: Accepted

Decision:
Published template versions are immutable.

Reason:
Historical certificates must remain reproducible and auditable.

## ADR-003: Private Object Storage

Status: Accepted

Decision:
Certificate PDFs are private.

Reason:
Avoid permanent public URLs and unauthorized direct access.

## ADR-004: Background PDF Generation

Status: Accepted

Decision:
Bulk PDF generation runs asynchronously.

Reason:
Avoid HTTP timeout and improve scalability/retry behavior.

## ADR-005: No Public Student Search

Status: Accepted

Decision:
Public interface verifies a known certificate token only.

Reason:
Prevent enumeration and unnecessary disclosure.

## ADR-006: Canonical Specification Ownership

Status: Accepted

Decision:

- `CODEX-START-HERE.md` is the canonical repository entry point.
- `IMPLEMENTATION-ROADMAP.md` is the canonical Phase 0–8 numbering.
- `docs/10-api-contract.md` is the API source of truth.
- `docs/19-openapi-outline.md` must mirror, not redefine, that contract.

Reason:
Prevent filename, phase and API contract drift.

## ADR-007: Database-Enforced Tenant Integrity

Status: Accepted

Decision:
Every tenant-owned row carries `organization_id`. Cross-entity tenant ownership is enforced with composite unique keys and composite foreign keys in addition to backend authorization.

Reason:
Application-only organization checks can regress and permit cross-tenant associations or IDOR impact.

Trade-off:
Tenant keys are intentionally repeated on child tables and every write must supply consistent organization context.

## ADR-008: Membership-Based RBAC

Status: Accepted

Decision:
Users are global identities. Organization access is represented by organization memberships, and organization roles attach to those memberships. `SUPER_ADMIN` is a separately assigned system role and cannot be assigned as an organization role.

Reason:
This makes tenant scope explicit and prevents frontend role claims or a user ID alone from granting organization access.

## ADR-009: Explicit Import and Generation Jobs

Status: Accepted

Decision:
Use a common organization-scoped job record with typed detail and item tables for participant import and certificate generation. Jobs record idempotency, progress, bounded attempts and terminal dead-letter state.

Reason:
Bulk processing must be retryable, observable and unable to create duplicate certificates.

## ADR-010: Template Assets Are Versioned Rendering Inputs

Status: Accepted

Decision:
Template assets are private, validated data referenced explicitly by template versions. Definition data and asset links are mutable only while a version is `DRAFT`. After `PUBLISHED`, rendering inputs are database-protected against modification or deletion; the version may only be archived.

Reason:
Historical certificates must remain deterministic and reproducible.

## ADR-011: Application-Controlled Secure Download

Status: Accepted

Decision:
Public download uses two POST operations: issue a short-lived certificate-scoped download token, then redeem it through the application for an authorized PDF stream. Both operations check current certificate status. Public responses never expose storage keys or permanent object URLs.

Reason:
This blocks revoked downloads, avoids permanent URLs and keeps bearer tokens out of URL paths and query strings.

## ADR-012: Public Token Subject Is Not an Internal ID

Status: Accepted

Decision:
Certificates have an immutable, globally unique `public_identifier` separate from the internal UUID. It is non-sequential, generated with at least 128 bits of cryptographically secure randomness and used as the signed verification-token subject. It is not sufficient for verification without a valid signature.

Reason:
Signed payloads provide integrity but are normally readable. A separate identifier prevents disclosure of database identity and decouples public protocol stability from internal keys.

## ADR-013: Canonical TypeScript Implementation Stack

Status: Accepted

Decision:

Lock the implementation baseline to:

- TypeScript full stack on the Node.js runtime required by the approved frameworks
- Next.js and Tailwind CSS for the web application
- Fastify and TypeScript for the canonical backend API
- PostgreSQL 16, Kysely and node-pg-migrate for persistence
- bcrypt, Redis-backed server-side sessions and session-bound CSRF protection
- custom JSON templates with Zod validation and an allowlisted data binder
- PDFKit and qrcode for certificate/QR rendering
- BullMQ and Redis for asynchronous work
- S3-compatible private storage, MinIO for Compose development and `@aws-sdk/client-s3`
- Zod for external and cross-process validation
- Vitest, Supertest and Playwright for testing
- Docker Compose as the deployment baseline

The package manager is pnpm with workspaces and one committed root lockfile.

Reason:
A single explicit baseline prevents framework duplication, contract drift and incompatible infrastructure choices across web, API and workers.

Consequences:

- Exact compatible dependency versions are pinned when Phase 1 scaffolding is authorized.
- A replacement or overlapping framework/library in any listed concern requires explicit approval and a superseding ADR.
- Next.js does not replace the Fastify API, and BullMQ/Redis does not replace durable PostgreSQL job state.

## ADR-014: pnpm Monorepo With Explicit Runtime Boundaries

Status: Accepted

Decision:

Use one pnpm workspace with three deployable applications:

- `apps/web` for Next.js/Tailwind admin and public UI
- `apps/api` for Fastify admin/public APIs
- `apps/worker` for BullMQ import and certificate-generation processors

Shared code is exposed through reviewed `@certificate-platform/*` packages for auth, configuration, browser-safe contracts, database, domain policy, queue contracts, storage, template engine, certificate rendering and test utilities.

Reason:
API and worker processes need shared contracts and domain rules without importing application entrypoints or creating circular dependencies. Browser-safe contracts must remain isolated from server secrets and infrastructure code.

Consequences:

- Shared packages cannot import from `apps/*`.
- Web code can consume browser-safe contracts but cannot import database, Redis, bcrypt, storage or signing modules.
- Package exports, strict TypeScript and workspace dependency direction are enforced from Phase 1 onward.

## ADR-015: Redis Server-Side Admin Sessions With CSRF

Status: Accepted

Decision:

Admin authentication uses bcrypt password verification and an opaque, cryptographically random session identifier in a `Secure`, `HttpOnly`, host-only cookie. Session state, expiry, user identity and authorization version are stored in Redis. State-changing admin requests require a session-bound CSRF token sent in a dedicated header.

Reason:
Server-side sessions support immediate logout, membership/role revocation and controlled rotation without putting authorization claims or long-lived bearer credentials in browser storage.

Consequences:

- Session IDs rotate after login and relevant privilege changes.
- Redis unavailability fails authenticated operations safely according to the documented availability policy.
- Bcrypt inputs are validated against its 72-byte boundary.
- Public verification/download endpoints remain accountless and do not use admin CSRF/session authorization.
