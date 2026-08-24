# 13 — PDF Generation Architecture

## Locked implementation

- BullMQ + Redis: queue delivery and retry coordination
- TypeScript worker: job processors
- PDFKit: PDF generation
- qrcode: verification QR generation
- `@aws-sdk/client-s3`: S3-compatible private storage access
- MinIO: Docker Compose development storage

PostgreSQL remains authoritative for job/item and certificate lifecycle state.

## Pre-Phase 5 certificate integrity contract

Before PDFKit/qrcode generation code is introduced, the database locks these invariants:

- Every certificate begins as a clean revision-1 `DRAFT`.
- Certificate public/internal issuance identity is immutable after creation.
- The certificate stores one immutable issuance-time snapshot of recipient display name, project name, training name, training code and the planned issue timestamp. Rendering must use this snapshot rather than re-reading mutable live rows or choosing a new issue time on retry.
- A certificate cannot enter `GENERATING` without that snapshot.
- The initial lifecycle is `DRAFT → GENERATING → AVAILABLE → REVOKED`; revocation is terminal. `ISSUED` and `ARCHIVED` remain reserved enum values until a later reviewed contract defines them.
- Publication to `AVAILABLE` requires a `SUCCEEDED` generation item for the exact certificate/template/revision.
- Regeneration is prepared while the current certificate remains `AVAILABLE`. The new PDF is published by atomically advancing exactly one generation revision and swapping its integrity metadata; the original issue time remains unchanged.
- A worker holding a stale revision cannot replace current PDF metadata. Generation-job detail inputs are immutable after insertion.

These are database invariants, not conventions left only to worker code.

## Flow

Import
→ Validate
→ Create generation job
→ Queue
→ BullMQ worker
→ Validate/bind custom JSON template
→ Generate QR with qrcode
→ Generate PDF with PDFKit
→ Validate PDF
→ Upload private storage
→ Mark certificate AVAILABLE

## Worker rules

- idempotent jobs
- retries with backoff
- dead-letter handling
- bounded concurrency
- no untrusted network access
- no remote template/font/image fetches
- temporary files cleaned up
- memory/CPU/time limits

## Idempotency and generation planning

The client supplies an opaque `Idempotency-Key`; it is not derived from certificate IDs. PostgreSQL scopes that key by organization and job type, while `certificate_generation_jobs.request_fingerprint` binds the key to the exact request effect.

Fingerprint version 1 includes:

- organization
- certificate-generation operation/version
- training
- published template version
- selection mode (`EXPLICIT` or `ALL_ELIGIBLE`)
- the exact first-resolved participant IDs in canonical sorted order

The server-selected renderer revision is stored separately as an immutable execution input. It is intentionally not part of the client request fingerprint so a replay of an already-created request after deployment still returns the original job and original renderer revision.

For `ALL_ELIGIBLE`, resolution happens only during the first job-creation transaction. Certificates, immutable issuance snapshots and generation items materialize the exact set before the durable outbox intent is committed. A retry of the same all-eligible request never selects newly-added participants. Workers render only durable planned items and never query "all current participants" to decide job membership.

The database represents this flow with:

- `jobs` for organization-scoped status, progress, attempts and the client idempotency key
- `certificate_generation_jobs` for immutable training, published template version, revision, selection mode, exact-target request fingerprint and renderer revision
- `certificates` + `certificate_issuance_snapshots` for immutable per-recipient issuance identity/bindings/planned issue time
- `certificate_generation_items` for one certificate/revision work item

The unique `(certificate_id, generation_revision)` boundary prevents queue retries from rendering one revision as separate work. A separate partial unique certificate boundary permits only one non-revoked certificate per training participant. Initial generation never acts as an implicit reissue; a revoked certificate can receive a new identity only through an explicit reissue operation.

BullMQ job IDs and retry configuration must derive from the durable database job/item identity. Queue redelivery must resume or safely no-op against PostgreSQL state instead of creating a new certificate.

## Storage

Store:
- private object key
- SHA-256 content hash
- positive byte size
- MIME type fixed to `application/pdf`

Do not expose bucket paths publicly.

All storage operations go through the shared S3-compatible adapter using `@aws-sdk/client-s3`. The worker validates returned object metadata before transitioning the certificate to `AVAILABLE`.

## Download

The canonical public flow is application-controlled streaming:

1. Verify the signed verification token and require current `AVAILABLE` state.
2. Issue a signed, audience-scoped download token valid for at most 60 seconds.
3. Redeem the token by POST through the application.
4. Recheck token expiry/audience and current `AVAILABLE` state.
5. Validate stored PDF metadata and stream the private object.

Do not expose storage keys, internal UUIDs or permanent object URLs. A certificate revoked between steps 2 and 3 must not download.
