# 05 — Database Design

## Authority

This document defines PostgreSQL 16 integrity rules. `docs/08-erd.md` describes relationships and `docs/09-postgresql-schema.sql` is the canonical reference schema. Phase 1 migrations are implemented with node-pg-migrate, and application queries use Kysely. This specification file is not itself a migration.

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

- Certificates retain their original `template_version_id`.
- `AVAILABLE` requires issue timestamp, private storage key, SHA-256 hash, size and `application/pdf` MIME metadata.
- Revocation records current state and timestamp; public download checks that state on every authorization and redemption.
- Regeneration increments `generation_revision` and retains an auditable job/item trail.

## Audit and event data

- Audit rows are append-only.
- Metadata uses reviewed action-specific schemas and never stores tokens, passwords, keys or unnecessary PII.
- Public verification/download events may have no certificate or organization when resolution fails.
- Security telemetry and event retention must follow `docs/02-security-privacy.md` and `docs/22-privacy-policy-design.md`.
