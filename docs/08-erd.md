# 08 — Database ERD

## Scope

This ERD reflects the current logical database contract, including append-only migrations after the frozen Phase 0 snapshot in `docs/09-postgresql-schema.sql`. Internal primary keys are UUIDs. Public verification uses a separate random `certificates.public_identifier` and never exposes `certificates.id`.

## Core relationships

- Users are global identities; organization access is represented by memberships.
- Organization roles attach to memberships. `SUPER_ADMIN` attaches directly to a user as a system role.
- Every tenant-owned relationship includes `organization_id` and is enforced with composite foreign keys in the PostgreSQL schema.
- Participants join trainings through `training_participants` before certificates are issued.
- Background work uses a common job plus import/generation detail and item rows.
- Template versions and their asset links become immutable after publication.
- Certificates remain tied to the published template version and generation revision used to render them.
- Each certificate has exactly one immutable issuance snapshot containing the issuance-time human-readable binding values that would otherwise come from mutable participant/project/training rows.

## Mermaid ERD

```mermaid
erDiagram
    ORGANIZATIONS ||--o{ ORGANIZATION_MEMBERSHIPS : contains
    USERS ||--o{ ORGANIZATION_MEMBERSHIPS : joins
    USERS ||--o{ USER_SYSTEM_ROLES : receives
    ROLES ||--o{ USER_SYSTEM_ROLES : grants
    ORGANIZATION_MEMBERSHIPS ||--o{ MEMBERSHIP_ROLES : receives
    ROLES ||--o{ MEMBERSHIP_ROLES : grants
    ROLES ||--o{ ROLE_PERMISSIONS : includes
    PERMISSIONS ||--o{ ROLE_PERMISSIONS : maps

    ORGANIZATIONS ||--o{ PROJECTS : owns
    PROJECTS ||--o{ TRAININGS : contains
    ORGANIZATIONS ||--o{ PARTICIPANTS : owns
    TRAININGS ||--o{ TRAINING_PARTICIPANTS : enrolls
    PARTICIPANTS ||--o{ TRAINING_PARTICIPANTS : joins

    ORGANIZATIONS ||--o{ CERTIFICATE_TEMPLATES : owns
    CERTIFICATE_TEMPLATES ||--o{ TEMPLATE_VERSIONS : versions
    CERTIFICATE_TEMPLATES ||--o{ TEMPLATE_ASSETS : owns
    TEMPLATE_VERSIONS ||--o{ TEMPLATE_VERSION_ASSETS : binds
    TEMPLATE_ASSETS ||--o{ TEMPLATE_VERSION_ASSETS : supplies

    ORGANIZATIONS ||--o{ JOBS : owns
    JOBS ||--o| PARTICIPANT_IMPORT_JOBS : details
    PARTICIPANT_IMPORT_JOBS ||--o{ PARTICIPANT_IMPORT_ROWS : stages
    PARTICIPANT_IMPORT_JOBS o|--o{ TRAINING_PARTICIPANTS : sources
    JOBS ||--o| CERTIFICATE_GENERATION_JOBS : details
    CERTIFICATE_GENERATION_JOBS ||--o{ CERTIFICATE_GENERATION_ITEMS : contains

    TRAINING_PARTICIPANTS ||--o{ CERTIFICATES : receives
    TEMPLATE_VERSIONS ||--o{ CERTIFICATES : renders
    CERTIFICATES ||--|| CERTIFICATE_ISSUANCE_SNAPSHOTS : freezes
    CERTIFICATES ||--o{ CERTIFICATE_GENERATION_ITEMS : generated_by
    CERTIFICATES ||--o{ VERIFICATION_EVENTS : verifies
    CERTIFICATES ||--o{ DOWNLOAD_EVENTS : downloads
    USERS ||--o{ AUDIT_LOGS : acts

    ORGANIZATIONS {
      uuid id PK
      text name
      record_status status
    }

    USERS {
      uuid id PK
      text email UK
      text password_hash
      record_status status
    }

    ORGANIZATION_MEMBERSHIPS {
      uuid id PK
      uuid organization_id FK
      uuid user_id FK
      record_status status
    }

    ROLES {
      role_code code PK
      text scope
    }

    PERMISSIONS {
      text code PK
      text description
    }

    ROLE_PERMISSIONS {
      role_code role PK,FK
      text permission_code PK,FK
    }

    USER_SYSTEM_ROLES {
      uuid user_id PK,FK
      role_code role PK,FK
    }

    MEMBERSHIP_ROLES {
      uuid membership_id PK,FK
      uuid organization_id FK
      role_code role PK,FK
    }

    PROJECTS {
      uuid id PK
      uuid organization_id FK
      text name
      text slug
      record_status status
    }

    TRAININGS {
      uuid id PK
      uuid organization_id FK
      uuid project_id FK
      text name
      text code
      date start_date
      date end_date
    }

    PARTICIPANTS {
      uuid id PK
      uuid organization_id FK
      text external_reference
      text display_name
    }

    TRAINING_PARTICIPANTS {
      uuid id PK
      uuid organization_id FK
      uuid training_id FK
      uuid participant_id FK
      uuid source_import_job_id FK
      record_status status
    }

    CERTIFICATE_TEMPLATES {
      uuid id PK
      uuid organization_id FK
      text name
      record_status status
    }

    TEMPLATE_ASSETS {
      uuid id PK
      uuid organization_id FK
      uuid template_id FK
      text storage_key
      bytea content_sha256
      text detected_mime_type
      bigint size_bytes
      template_asset_status status
    }

    TEMPLATE_VERSIONS {
      uuid id PK
      uuid organization_id FK
      uuid template_id FK
      int version
      jsonb definition_json
      template_version_status status
      timestamptz published_at
    }

    TEMPLATE_VERSION_ASSETS {
      uuid template_version_id PK,FK
      uuid asset_id PK,FK
      uuid organization_id FK
      uuid template_id FK
    }

    JOBS {
      uuid id PK
      uuid organization_id FK
      job_type job_type
      job_status status
      text idempotency_key
      int progress_completed
      int progress_total
      int attempt_count
      int max_attempts
    }

    PARTICIPANT_IMPORT_JOBS {
      uuid job_id PK,FK
      uuid organization_id FK
      uuid training_id FK
      text source_storage_key
      bytea content_sha256
      timestamptz confirmed_at
    }

    PARTICIPANT_IMPORT_ROWS {
      uuid id PK
      uuid organization_id FK
      uuid job_id FK
      int row_number
      text display_name
      text external_reference
      import_row_status status
      jsonb validation_errors
      uuid participant_id FK
    }

    CERTIFICATE_GENERATION_JOBS {
      uuid job_id PK,FK
      uuid organization_id FK
      uuid training_id FK
      uuid template_version_id FK
      int generation_revision
    }

    CERTIFICATES {
      uuid id PK
      text public_identifier UK
      uuid organization_id FK
      uuid training_id FK
      uuid participant_id FK
      uuid template_version_id FK
      text certificate_number UK
      certificate_status status
      int generation_revision
      text pdf_storage_key
      bytea pdf_content_sha256
      bigint pdf_size_bytes
      text pdf_mime_type
      timestamptz issued_at
      timestamptz revoked_at
      text revocation_reason
    }

    CERTIFICATE_ISSUANCE_SNAPSHOTS {
      uuid certificate_id PK,FK
      uuid organization_id FK
      int snapshot_schema_version
      text recipient_display_name
      text project_name
      text training_name
      text training_code
      timestamptz created_at
    }

    CERTIFICATE_GENERATION_ITEMS {
      uuid id PK
      uuid organization_id FK
      uuid job_id FK
      uuid certificate_id FK
      int generation_revision
      job_item_status status
      int attempt_count
    }

    AUDIT_LOGS {
      uuid id PK
      uuid organization_id FK
      uuid actor_user_id FK
      uuid actor_membership_id FK
      text action
      text resource_type
      uuid resource_id
      uuid request_id
      jsonb metadata
      timestamptz created_at
    }

    VERIFICATION_EVENTS {
      uuid id PK
      uuid organization_id FK
      uuid certificate_id FK
      text result
      uuid request_id
      text network_fingerprint
      timestamptz created_at
    }

    DOWNLOAD_EVENTS {
      uuid id PK
      uuid organization_id FK
      uuid certificate_id FK
      text result
      uuid request_id
      text network_fingerprint
      timestamptz created_at
    }
```

## Enforced integrity rules

1. Composite foreign keys prevent projects, trainings, participants, template versions, jobs and certificates from being joined across organizations.
2. `SUPER_ADMIN` cannot be assigned through `membership_roles`; organization roles cannot use the system-role table.
3. `certificates.public_identifier` is random, globally unique and immutable. The internal certificate UUID is never a public token claim.
4. A certificate references an existing `training_participants` tuple in the same organization.
5. Published/archived template definition fields and asset links are protected by database triggers.
6. Version-to-asset links require the same organization and template. Assets used by published/archived versions cannot have their rendering content or storage identity changed.
7. Certificate issuance identity and the one-to-one issuance snapshot are immutable; mutable live names cannot rewrite historical certificate meaning.
8. The initial certificate lifecycle is database-guarded as `DRAFT → GENERATING → AVAILABLE → REVOKED`; revoked certificates are terminal.
9. `AVAILABLE` certificates require complete PDF integrity metadata, and publication requires a succeeded generation item for the exact revision.
10. Generation revisions advance exactly one step during regeneration publication; PDF metadata cannot be overwritten at the same revision, so stale writers fail closed.
11. Generation-job detail rows are immutable. Generation items must target the current revision for initial work or exactly the next revision for regeneration.
12. Import and generation item triggers require the same training/template/revision as their parent job.
13. Audit actor membership, organization and user are bound by a composite foreign key; audit log rows are append-only.

The complete signed verification token is intentionally absent from the database.
