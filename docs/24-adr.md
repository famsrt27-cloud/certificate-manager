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

## ADR-016: Immutable Certificate Issuance Snapshot and Lifecycle

Status: Accepted

Decision:

Before Phase 5 rendering is implemented:

- create certificates only as revision-1 drafts
- freeze certificate identity after creation
- capture one immutable issuance-time snapshot containing the human-readable binding values sourced from participant/project/training data
- render historical/regenerated PDFs from that snapshot rather than mutable live business rows
- enforce the initial lifecycle as `DRAFT → GENERATING → AVAILABLE → REVOKED`, with revocation terminal
- require a succeeded generation item before publishing a PDF revision
- keep an available certificate available during regeneration and atomically publish only the next revision
- reject same-revision PDF replacement, revision rollback/skip and immutable generation-job mutation

`ISSUED` and `ARCHIVED` remain reserved certificate enum values until a later reviewed ADR/migration defines their lifecycle semantics.

Reason:

Participant, project and training records remain legitimately editable after issuance. Re-reading those live rows during regeneration or public verification would silently change the historical meaning of an existing certificate. Likewise, an unrestricted lifecycle or same-revision PDF update could let a stale worker resurrect a revoked certificate or overwrite a newer PDF. The database therefore owns these integrity boundaries in addition to application-level compare-and-swap logic.

Consequences:

- Phase 5 must create the certificate and its issuance snapshot atomically before generation starts.
- Phase 5 worker finalization must mark the generation item successful and publish the certificate revision in one controlled transaction.
- Regeneration does not change the original issuance snapshot or `issued_at`.
- A revoked certificate is never regenerated or transitioned back to an available state.
- Later lifecycle expansion requires an explicit migration and ADR update rather than weakening the trigger in application code.

## ADR-017: Exact Generation Target Set, Planned Issue Time and Explicit Reissue

Status: Accepted

Decision:

Certificate-generation planning is a durable PostgreSQL transaction:

- the client idempotency key is scoped by organization/job type and is bound to immutable generation request identity
- generation detail stores `selection_mode`, a 32-byte SHA-256 fingerprint of the exact first-resolved participant set and the server-selected renderer revision
- omitted `participant_ids` resolves `ALL_ELIGIBLE` once; workers and later retries never re-resolve a changed population
- the transaction materializes certificate identity, one immutable issuance snapshot and one generation item for every selected participant before durable queue intent commits
- the issuance snapshot includes the planned issue timestamp used by rendering and later copied exactly into `certificates.issued_at`
- at most one non-revoked certificate may exist for one organization/training/participant
- initial generation does not silently reissue historical certificates; a new identity after revocation requires an explicit reissue operation

The renderer revision is intentionally stored separately from the client request fingerprint. Replaying an already-created request after a deployment returns the original job and renderer revision instead of changing its execution semantics.

Reason:

A batch request whose membership is resolved later by a worker is not idempotent: participant membership can change between API acceptance, retry and queue delivery. Likewise, selecting issue time during rendering changes certificate bindings across retries. Materializing the exact target set and planned issue time at first acceptance turns generation into durable work against immutable inputs. Separating initial issue from reissue avoids accidental duplicate certificate identities.

Consequences:

- Phase 5 job creation must compare existing idempotency-key semantics before creating any new certificate rows.
- Explicit participant lists are unique/all-or-conflict; omitted lists resolve only currently eligible initial-issue targets.
- A retry of an existing `ALL_ELIGIBLE` job returns the original job without re-resolving current participants.
- Workers may not infer job membership from live training relationships.
- Reissue requires a later explicit API contract and must create a fresh certificate number/public identifier while retaining revoked history.

## ADR-018: Capability-Minimized Certificate Renderer Boundary

Status: Accepted

Decision:

Create `packages/certificate-renderer` before Phase 5 PDF implementation. Its public boundary accepts only a strict versioned render input: normalized template data, immutable issuance binding values, renderer revision, a prepared verification URL and exactly referenced validated asset bytes with SHA-256 identity.

The renderer package:

- depends on the template engine/Zod validation boundary only
- does not import database, storage, queue, auth or network infrastructure
- never receives storage keys, signing keys or a token-signing service
- revalidates exact asset membership/purpose/MIME/hash and an explicit aggregate byte budget
- copies caller-owned asset bytes at the boundary
- treats the verification URL as already-authorized data and never signs tokens itself

The worker remains the trusted infrastructure adapter. It loads durable PostgreSQL state/private objects and later calls the verification-token service before invoking the renderer.

Reason:

PDF/template processing is an untrusted resource boundary. Passing rich worker/service objects into renderer code would unnecessarily grant database, S3, queue, filesystem or signing capabilities and make later isolation materially harder. A narrow serializable input also creates a deterministic seam for tests and future worker-thread/child-process isolation.

Consequences:

- Phase 5 PDFKit/qrcode implementation goes behind this package API rather than inside API/worker service code.
- Same-process package separation is not called a sandbox; production resource/process isolation remains a separate hardening requirement.
- Security tests fail if forbidden infrastructure dependencies are introduced into renderer source/package metadata.
- Phase 6 token code must keep verification-token time/key selection stable for existing certificates; renderer regeneration consumes the resulting prepared URL only.

## Public certificate discovery and download capability separation

Public discovery is an organization-opt-in boundary with default off. Included certificates may be found only while `AVAILABLE`, by exact certificate number or exact canonical immutable recipient snapshot plus project/training context. Recipient canonicalization uses NFKC, collapsed whitespace and removal of at most one allowlisted leading Thai title; arbitrary partial and fuzzy people matching remain prohibited. Inputs, distributed rate, returned rows and fields are bounded; there are no totals or pagination. `training_name` is approved only for this dedicated search response and does not alter QR verification disclosure.

Each result carries a distinct 180-second search-result capability. Its exchange rechecks current publication state and issues the existing download capability, so private object storage and final redemption controls remain unchanged. The base schema/policy extension is recorded in migration `202608300009_public-certificate-search`; the indexed canonical title handling is recorded in migration `202608310010_canonical-recipient-name-search`. Administration is limited to one organization-level toggle on the existing dashboard rather than a new settings subsystem.

Public project/training discovery is label-only and prefix-gated against the same opted-in `AVAILABLE` snapshot boundary. No stable public context identifier is needed because the selected canonical label is submitted to the existing exact normalized search contract. The current policy remains organization-wide. A possible future enhancement is per-training public-search visibility, but it requires a separately reviewed domain/schema/API change and is not implemented here.
