# 05 — Database Design

## Authority

This document defines the current PostgreSQL 16 integrity rules. `docs/08-erd.md` describes the current logical relationships. `docs/09-postgresql-schema.sql` is the frozen Phase 0 / migration-0001 schema snapshot and must not be edited to represent later schema evolution. Applied schema evolution after migration 0001 is authoritative in the append-only files under `packages/database/migrations/`. Application queries use Kysely, and this specification file is not itself a migration.

## Implementation ownership

- `packages/database/migrations/` contains append-only node-pg-migrate migrations.
- `packages/database/src/` contains Kysely configuration, generated/maintained database types, repositories and transaction helpers.
- Kysely types reflect the applied PostgreSQL schema; they are not an independent schema source.
- Migrations must be reviewed against this document, the ERD and reference schema before application.
- Applied migrations are never edited in place in a shared environment; corrections use a new migration.
- Integration tests use PostgreSQL 16 rather than an in-memory substitute.

## Tenant integrity

- `organizations.id` defines the tenant boundary.
- Every tenant-owned table stores `organization_id`.
- Parent tables expose composite unique keys such as `(id, organization_id)`.
- Child tables use composite foreign keys containing `organization_id`; application-only tenant checks are insufficient.
- A certificate must reference a training participant and template version belonging to the same organization.
- Global lookup by public certificate identifier returns one certificate and never changes authorization rules for admin access.

## Identity and RBAC

- Users are global identities and may have organization memberships.
- Organization roles are assigned to memberships, not trusted from frontend claims.
- `SUPER_ADMIN` is assigned through the system-role table only.
- `ORG_ADMIN`, `CERTIFICATE_MANAGER`, `TEMPLATE_MANAGER` and `VIEWER` are assigned through organization membership roles.
- Role-to-permission mappings are explicit and seeded from reviewed data.

## Public certificate identity

`certificates.id` is an internal UUID. `certificates.public_identifier` is a separate globally unique, cryptographically random 128-bit value encoded as 32 lowercase hexadecimal characters.

The public identifier:

- is not a secret and is not sufficient for authorization by itself
- is the only certificate identifier allowed inside a public verification token
- must not replace the signed token in public APIs
- cannot be updated after certificate creation

The complete signed token is not stored in the database.

## Participant import

- An import is represented by a `jobs` row plus a `participant_import_jobs` detail row.
- Parsed rows are staged in `participant_import_rows` for validation and preview.
- Only display name and optional external reference are accepted by default.
- Confirmed valid rows create/update participants according to the approved deduplication policy and create `training_participants` relationships.
- Source files and staged rows follow a documented temporary retention policy.

The Phase 3 deduplication policy is organization-scoped and exact: a non-empty normalized `external_reference` identifies at most one import target inside the organization, while a row without an external reference always creates a new participant. Display names are never identity keys. Duplicate references inside one source are invalid. Import and participant-update transactions take an organization/reference advisory lock before lookup/update so concurrent application work cannot create two targets; an already-ambiguous legacy reference fails safely rather than choosing a participant. The canonical schema remains unchanged.

Import source objects are removed after validation staging. Successful confirmation removes staged rows after creating durable participant/training relationships. Jobs left awaiting confirmation and terminal staged data are cancelled/removed after the configured retention window, 168 hours by default.

## Background jobs

- `jobs` stores shared state, progress, attempts and organization-scoped idempotency keys.
- Job detail tables bind a job to its domain inputs.
- Certificate generation uses item rows with a deterministic `(certificate_id, generation_revision)` uniqueness boundary.
- Generation-job detail stores immutable `selection_mode`, a 32-byte request fingerprint of the exact first-resolved participant set and the server-selected `renderer_revision`.
- An omitted participant list is resolved exactly once at first job creation; the resulting participant set is materialized as certificate/item rows in the same PostgreSQL transaction before queue intent becomes visible. Workers never re-resolve "all eligible" from mutable live rows.
- Retried work updates the same item/revision and cannot create a duplicate certificate.
- `DEAD_LETTER` is an explicit terminal state requiring controlled operator action.
- BullMQ is the delivery mechanism; PostgreSQL job/item state remains authoritative for progress, idempotency and recovery.

## Template assets and immutability

- Assets are private objects with validated MIME, content hash and size metadata.
- Template versions reference assets through `template_version_assets`.
- Draft definitions and asset links may be edited.
- After publish, definition data, version identity and asset links are immutable.
- Archiving a published version does not modify its historical rendering inputs.
- Assets referenced by a published or archived version cannot have their content/storage identity changed or be deleted.

## Certificate and PDF integrity

- A certificate is created only as a clean `DRAFT` at generation revision 1.
- Certificate identity is immutable after creation: public identifier, organization, training, participant, published template version and certificate number cannot be replaced.
- Before a certificate may enter `GENERATING`, one immutable `certificate_issuance_snapshots` row must capture the issuance-time recipient display name, project name, training name, training code and planned `issued_at`. Later edits to the live participant/project/training rows do not alter historical rendering or public verification meaning.
- Snapshot rows are append-once: they may be inserted only while the parent certificate is `DRAFT` and cannot be updated or deleted.
- The Phase 5 initial lifecycle is `DRAFT → GENERATING → AVAILABLE → REVOKED`. `REVOKED` is terminal. Existing enum states `ISSUED` and `ARCHIVED` are reserved and are not entered by the Phase 5 contract until a later reviewed migration explicitly defines their semantics.
- `AVAILABLE` requires issue timestamp, private storage key, SHA-256 hash, size and `application/pdf` MIME metadata.
- Initial publication and regeneration publication require a `SUCCEEDED` generation item for the exact certificate, template and revision. Initial publication must persist the exact planned `issued_at` from the immutable issuance snapshot.
- At most one non-revoked certificate may exist for one organization/training/participant tuple. Initial generation treats any certificate history as ineligible for a new initial issue; after revocation, a brand-new certificate/public identifier/number may be created only by an explicit reissue operation defined by a reviewed API contract.
- Regeneration keeps an already-available certificate available while rendering the next revision. Publishing a regenerated PDF atomically advances `generation_revision` by exactly one and replaces the PDF integrity metadata. The original `issued_at` does not change.
- PDF identity cannot be overwritten without a revision advance. This makes stale workers fail closed after another worker has already published the same or a newer revision.
- Certificate generation-job detail rows are immutable durable inputs after insertion.
- Revocation metadata is immutable after revocation; public download checks current state on every authorization and redemption.

## Audit and event data

- Audit rows are append-only.
- Metadata uses reviewed action-specific schemas and never stores tokens, passwords, keys or unnecessary PII.
- Public verification/download events may have no certificate or organization when resolution fails.
- Security telemetry and event retention must follow `docs/02-security-privacy.md` and `docs/22-privacy-policy-design.md`.
