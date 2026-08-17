# 13 — PDF Generation Architecture

## Locked implementation

- BullMQ + Redis: queue delivery and retry coordination
- TypeScript worker: job processors
- PDFKit: PDF generation
- qrcode: verification QR generation
- `@aws-sdk/client-s3`: S3-compatible private storage access
- MinIO: Docker Compose development storage

PostgreSQL remains authoritative for job/item and certificate lifecycle state.

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

## Idempotency

A generation job must have a deterministic idempotency key based on:
- certificate ID
- template version
- generation revision

Do not create duplicate certificates from a retry.

The database represents this flow with:

- `jobs` for organization-scoped status, progress, attempts and idempotency
- `certificate_generation_jobs` for training, published template version and revision
- `certificate_generation_items` for one certificate/revision work item

The unique `(certificate_id, generation_revision)` boundary prevents retries or duplicate requests from rendering the same revision as separate work.

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
