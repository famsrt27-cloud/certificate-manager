-- 09 — PostgreSQL 16 Reference Schema
-- Phase 0 contract only. This file is not an applied migration.
-- Phase 1 migrations use node-pg-migrate; application queries use Kysely.
-- Internal IDs use UUIDs. Public verification uses certificates.public_identifier.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE record_status AS ENUM ('ACTIVE','INACTIVE','ARCHIVED');
CREATE TYPE certificate_status AS ENUM ('DRAFT','GENERATING','ISSUED','AVAILABLE','REVOKED','ARCHIVED');
CREATE TYPE template_version_status AS ENUM ('DRAFT','PUBLISHED','ARCHIVED');
CREATE TYPE role_code AS ENUM ('SUPER_ADMIN','ORG_ADMIN','CERTIFICATE_MANAGER','TEMPLATE_MANAGER','VIEWER');
CREATE TYPE job_type AS ENUM ('PARTICIPANT_IMPORT','CERTIFICATE_GENERATION');
CREATE TYPE job_status AS ENUM ('QUEUED','RUNNING','AWAITING_CONFIRMATION','SUCCEEDED','FAILED','DEAD_LETTER','CANCELLED');
CREATE TYPE job_item_status AS ENUM ('PENDING','RUNNING','SUCCEEDED','FAILED','DEAD_LETTER','SKIPPED');
CREATE TYPE import_row_status AS ENUM ('PENDING','VALID','INVALID','IMPORTED','FAILED');
CREATE TYPE template_asset_status AS ENUM ('QUARANTINED','ACTIVE','REJECTED','ARCHIVED');

CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    status record_status NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    status record_status NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_normalized_uq ON users (lower(email));

CREATE TABLE organization_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    user_id UUID NOT NULL REFERENCES users(id),
    status record_status NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, user_id),
    UNIQUE (id, organization_id),
    UNIQUE (id, organization_id, user_id)
);

CREATE TABLE roles (
    code role_code PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('SYSTEM','ORGANIZATION')),
    description TEXT NOT NULL
);

CREATE TABLE permissions (
    code TEXT PRIMARY KEY,
    description TEXT NOT NULL
);

CREATE TABLE role_permissions (
    role role_code NOT NULL REFERENCES roles(code),
    permission_code TEXT NOT NULL REFERENCES permissions(code),
    PRIMARY KEY (role, permission_code)
);

CREATE TABLE user_system_roles (
    user_id UUID NOT NULL REFERENCES users(id),
    role role_code NOT NULL CHECK (role = 'SUPER_ADMIN'),
    granted_by_user_id UUID REFERENCES users(id),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, role)
);

CREATE TABLE membership_roles (
    membership_id UUID NOT NULL,
    organization_id UUID NOT NULL,
    role role_code NOT NULL CHECK (role <> 'SUPER_ADMIN'),
    granted_by_user_id UUID REFERENCES users(id),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (membership_id, role),
    FOREIGN KEY (membership_id, organization_id)
        REFERENCES organization_memberships(id, organization_id)
);

CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    status record_status NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, slug),
    UNIQUE (id, organization_id)
);

CREATE TABLE trainings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    project_id UUID NOT NULL,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    start_date DATE,
    end_date DATE,
    status record_status NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, project_id, code),
    UNIQUE (id, organization_id),
    FOREIGN KEY (project_id, organization_id)
        REFERENCES projects(id, organization_id),
    CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

CREATE TABLE participants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    external_reference TEXT,
    display_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, organization_id)
);

CREATE INDEX participants_org_idx ON participants(organization_id);
CREATE INDEX participants_external_ref_idx ON participants(organization_id, external_reference)
    WHERE external_reference IS NOT NULL;

CREATE TABLE certificate_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL,
    status record_status NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, organization_id)
);

CREATE TABLE template_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    template_id UUID NOT NULL,
    storage_key TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    content_sha256 BYTEA NOT NULL CHECK (octet_length(content_sha256) = 32),
    detected_mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
    width_px INTEGER CHECK (width_px IS NULL OR width_px > 0),
    height_px INTEGER CHECK (height_px IS NULL OR height_px > 0),
    status template_asset_status NOT NULL DEFAULT 'QUARANTINED',
    created_by_membership_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, storage_key),
    UNIQUE (id, organization_id),
    UNIQUE (id, organization_id, template_id),
    FOREIGN KEY (template_id, organization_id)
        REFERENCES certificate_templates(id, organization_id),
    FOREIGN KEY (created_by_membership_id, organization_id)
        REFERENCES organization_memberships(id, organization_id)
);

CREATE TABLE template_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    template_id UUID NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    definition_json JSONB NOT NULL,
    status template_version_status NOT NULL DEFAULT 'DRAFT',
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (template_id, version),
    UNIQUE (id, organization_id),
    UNIQUE (id, organization_id, template_id),
    FOREIGN KEY (template_id, organization_id)
        REFERENCES certificate_templates(id, organization_id),
    CHECK (
        (status = 'DRAFT' AND published_at IS NULL)
        OR (status IN ('PUBLISHED','ARCHIVED') AND published_at IS NOT NULL)
    )
);

CREATE TABLE template_version_assets (
    template_version_id UUID NOT NULL,
    asset_id UUID NOT NULL,
    organization_id UUID NOT NULL,
    template_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (template_version_id, asset_id),
    FOREIGN KEY (template_version_id, organization_id, template_id)
        REFERENCES template_versions(id, organization_id, template_id),
    FOREIGN KEY (asset_id, organization_id, template_id)
        REFERENCES template_assets(id, organization_id, template_id)
);

CREATE TABLE jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    job_type job_type NOT NULL,
    status job_status NOT NULL DEFAULT 'QUEUED',
    idempotency_key TEXT NOT NULL,
    progress_completed INTEGER NOT NULL DEFAULT 0 CHECK (progress_completed >= 0),
    progress_total INTEGER NOT NULL DEFAULT 0 CHECK (progress_total >= 0),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
    last_error_code TEXT,
    requested_by_membership_id UUID NOT NULL,
    queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, job_type, idempotency_key),
    UNIQUE (id, organization_id),
    FOREIGN KEY (requested_by_membership_id, organization_id)
        REFERENCES organization_memberships(id, organization_id),
    CHECK (progress_completed <= progress_total OR progress_total = 0),
    CHECK (attempt_count <= max_attempts)
);

CREATE INDEX jobs_org_status_idx ON jobs(organization_id, status, created_at);

CREATE TABLE participant_import_jobs (
    job_id UUID PRIMARY KEY,
    organization_id UUID NOT NULL,
    training_id UUID NOT NULL,
    source_storage_key TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    content_sha256 BYTEA NOT NULL CHECK (octet_length(content_sha256) = 32),
    detected_mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
    confirmed_at TIMESTAMPTZ,
    UNIQUE (job_id, organization_id),
    FOREIGN KEY (job_id, organization_id)
        REFERENCES jobs(id, organization_id),
    FOREIGN KEY (training_id, organization_id)
        REFERENCES trainings(id, organization_id)
);

CREATE TABLE participant_import_rows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    job_id UUID NOT NULL,
    row_number INTEGER NOT NULL CHECK (row_number > 0),
    display_name TEXT,
    external_reference TEXT,
    status import_row_status NOT NULL DEFAULT 'PENDING',
    validation_errors JSONB,
    participant_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (job_id, row_number),
    FOREIGN KEY (job_id, organization_id)
        REFERENCES participant_import_jobs(job_id, organization_id),
    FOREIGN KEY (participant_id, organization_id)
        REFERENCES participants(id, organization_id)
);

CREATE TABLE training_participants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    training_id UUID NOT NULL,
    participant_id UUID NOT NULL,
    source_import_job_id UUID,
    status record_status NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, training_id, participant_id),
    UNIQUE (id, organization_id),
    FOREIGN KEY (training_id, organization_id)
        REFERENCES trainings(id, organization_id),
    FOREIGN KEY (participant_id, organization_id)
        REFERENCES participants(id, organization_id),
    FOREIGN KEY (source_import_job_id, organization_id)
        REFERENCES participant_import_jobs(job_id, organization_id)
);

CREATE TABLE certificate_generation_jobs (
    job_id UUID PRIMARY KEY,
    organization_id UUID NOT NULL,
    training_id UUID NOT NULL,
    template_version_id UUID NOT NULL,
    generation_revision INTEGER NOT NULL DEFAULT 1 CHECK (generation_revision > 0),
    UNIQUE (job_id, organization_id),
    FOREIGN KEY (job_id, organization_id)
        REFERENCES jobs(id, organization_id),
    FOREIGN KEY (training_id, organization_id)
        REFERENCES trainings(id, organization_id),
    FOREIGN KEY (template_version_id, organization_id)
        REFERENCES template_versions(id, organization_id)
);

CREATE TABLE certificates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    public_identifier TEXT NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    training_id UUID NOT NULL,
    participant_id UUID NOT NULL,
    template_version_id UUID NOT NULL,
    certificate_number TEXT NOT NULL,
    status certificate_status NOT NULL DEFAULT 'DRAFT',
    generation_revision INTEGER NOT NULL DEFAULT 1 CHECK (generation_revision > 0),
    pdf_storage_key TEXT,
    pdf_content_sha256 BYTEA CHECK (pdf_content_sha256 IS NULL OR octet_length(pdf_content_sha256) = 32),
    pdf_size_bytes BIGINT CHECK (pdf_size_bytes IS NULL OR pdf_size_bytes > 0),
    pdf_mime_type TEXT CHECK (pdf_mime_type IS NULL OR pdf_mime_type = 'application/pdf'),
    issued_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    revocation_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (public_identifier),
    UNIQUE (certificate_number),
    UNIQUE (id, organization_id),
    FOREIGN KEY (organization_id, training_id, participant_id)
        REFERENCES training_participants(organization_id, training_id, participant_id),
    FOREIGN KEY (template_version_id, organization_id)
        REFERENCES template_versions(id, organization_id),
    CHECK (public_identifier ~ '^[0-9a-f]{32}$'),
    CHECK (status <> 'REVOKED' OR revoked_at IS NOT NULL),
    CHECK (
        status <> 'AVAILABLE'
        OR (
            issued_at IS NOT NULL
            AND pdf_storage_key IS NOT NULL
            AND pdf_content_sha256 IS NOT NULL
            AND pdf_size_bytes IS NOT NULL
            AND pdf_mime_type = 'application/pdf'
        )
    )
);

CREATE INDEX certificates_training_idx ON certificates(organization_id, training_id);
CREATE INDEX certificates_participant_idx ON certificates(organization_id, participant_id);
CREATE INDEX certificates_status_idx ON certificates(organization_id, status);

CREATE TABLE certificate_generation_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    job_id UUID NOT NULL,
    certificate_id UUID NOT NULL,
    generation_revision INTEGER NOT NULL CHECK (generation_revision > 0),
    status job_item_status NOT NULL DEFAULT 'PENDING',
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (job_id, certificate_id),
    UNIQUE (certificate_id, generation_revision),
    FOREIGN KEY (job_id, organization_id)
        REFERENCES certificate_generation_jobs(job_id, organization_id),
    FOREIGN KEY (certificate_id, organization_id)
        REFERENCES certificates(id, organization_id)
);

CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id),
    actor_user_id UUID REFERENCES users(id),
    actor_membership_id UUID,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id UUID,
    request_id UUID NOT NULL,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (actor_membership_id, organization_id, actor_user_id)
        REFERENCES organization_memberships(id, organization_id, user_id),
    CHECK (
        actor_membership_id IS NULL
        OR (organization_id IS NOT NULL AND actor_user_id IS NOT NULL)
    )
);

CREATE INDEX audit_logs_org_created_idx ON audit_logs(organization_id, created_at);
CREATE INDEX audit_logs_resource_idx ON audit_logs(organization_id, resource_type, resource_id);

CREATE TABLE verification_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id),
    certificate_id UUID,
    result TEXT NOT NULL,
    request_id UUID NOT NULL,
    network_fingerprint TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (certificate_id, organization_id)
        REFERENCES certificates(id, organization_id),
    CHECK (certificate_id IS NULL OR organization_id IS NOT NULL)
);

CREATE INDEX verification_events_created_idx ON verification_events(created_at);
CREATE INDEX verification_events_certificate_idx ON verification_events(certificate_id, created_at);

CREATE TABLE download_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id),
    certificate_id UUID,
    result TEXT NOT NULL,
    request_id UUID NOT NULL,
    network_fingerprint TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (certificate_id, organization_id)
        REFERENCES certificates(id, organization_id),
    CHECK (certificate_id IS NULL OR organization_id IS NOT NULL)
);

CREATE INDEX download_events_created_idx ON download_events(created_at);
CREATE INDEX download_events_certificate_idx ON download_events(certificate_id, created_at);

-- Published versions retain immutable rendering inputs. A published version may
-- only transition to ARCHIVED; an archived version cannot transition again.
CREATE FUNCTION enforce_template_version_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND OLD.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'published or archived template versions cannot be deleted';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF OLD.status IN ('PUBLISHED','ARCHIVED') AND (
            NEW.organization_id IS DISTINCT FROM OLD.organization_id
            OR NEW.template_id IS DISTINCT FROM OLD.template_id
            OR NEW.version IS DISTINCT FROM OLD.version
            OR NEW.definition_json IS DISTINCT FROM OLD.definition_json
            OR NEW.published_at IS DISTINCT FROM OLD.published_at
        ) THEN
            RAISE EXCEPTION 'published template rendering inputs are immutable';
        END IF;

        IF OLD.status = 'DRAFT' AND NEW.status NOT IN ('DRAFT','PUBLISHED') THEN
            RAISE EXCEPTION 'invalid template version state transition';
        ELSIF OLD.status = 'PUBLISHED' AND NEW.status NOT IN ('PUBLISHED','ARCHIVED') THEN
            RAISE EXCEPTION 'invalid template version state transition';
        ELSIF OLD.status = 'ARCHIVED' AND NEW.status <> 'ARCHIVED' THEN
            RAISE EXCEPTION 'archived template versions cannot transition';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER template_version_immutability_trg
BEFORE UPDATE OR DELETE ON template_versions
FOR EACH ROW EXECUTE FUNCTION enforce_template_version_immutability();

CREATE FUNCTION enforce_template_version_asset_mutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent_status template_version_status;
BEGIN
    IF TG_OP IN ('UPDATE','DELETE') THEN
        SELECT status INTO parent_status
        FROM template_versions
        WHERE id = OLD.template_version_id;

        IF parent_status <> 'DRAFT' THEN
            RAISE EXCEPTION 'asset links of published template versions are immutable';
        END IF;
    END IF;

    IF TG_OP IN ('INSERT','UPDATE') THEN
        SELECT status INTO parent_status
        FROM template_versions
        WHERE id = NEW.template_version_id;

        IF parent_status <> 'DRAFT' THEN
            RAISE EXCEPTION 'assets may only be linked to draft template versions';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER template_version_asset_mutability_trg
BEFORE INSERT OR UPDATE OR DELETE ON template_version_assets
FOR EACH ROW EXECUTE FUNCTION enforce_template_version_asset_mutability();

CREATE FUNCTION protect_published_template_asset_content()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND EXISTS (
        SELECT 1
        FROM template_version_assets tva
        JOIN template_versions tv ON tv.id = tva.template_version_id
        WHERE tva.asset_id = OLD.id
          AND tv.status IN ('PUBLISHED','ARCHIVED')
    ) THEN
        RAISE EXCEPTION 'assets used by published template versions are immutable';
    END IF;

    IF TG_OP = 'UPDATE' AND EXISTS (
        SELECT 1
        FROM template_version_assets tva
        JOIN template_versions tv ON tv.id = tva.template_version_id
        WHERE tva.asset_id = OLD.id
          AND tv.status IN ('PUBLISHED','ARCHIVED')
    ) AND (
        NEW.storage_key IS DISTINCT FROM OLD.storage_key
        OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
        OR NEW.detected_mime_type IS DISTINCT FROM OLD.detected_mime_type
        OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
        OR NEW.width_px IS DISTINCT FROM OLD.width_px
        OR NEW.height_px IS DISTINCT FROM OLD.height_px
        OR NEW.status IS DISTINCT FROM OLD.status
    ) THEN
        RAISE EXCEPTION 'assets used by published template versions are immutable';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER published_template_asset_content_trg
BEFORE UPDATE OR DELETE ON template_assets
FOR EACH ROW EXECUTE FUNCTION protect_published_template_asset_content();

CREATE FUNCTION enforce_job_detail_contract()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    declared_type job_type;
    version_status template_version_status;
BEGIN
    SELECT job_type INTO declared_type
    FROM jobs
    WHERE id = NEW.job_id
      AND organization_id = NEW.organization_id;

    IF TG_TABLE_NAME = 'participant_import_jobs' AND declared_type <> 'PARTICIPANT_IMPORT' THEN
        RAISE EXCEPTION 'participant import detail requires a PARTICIPANT_IMPORT job';
    ELSIF TG_TABLE_NAME = 'certificate_generation_jobs' THEN
        IF declared_type <> 'CERTIFICATE_GENERATION' THEN
            RAISE EXCEPTION 'certificate generation detail requires a CERTIFICATE_GENERATION job';
        END IF;

        SELECT status INTO version_status
        FROM template_versions
        WHERE id = NEW.template_version_id
          AND organization_id = NEW.organization_id;

        IF version_status <> 'PUBLISHED' THEN
            RAISE EXCEPTION 'certificate generation requires a published template version';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER participant_import_job_contract_trg
BEFORE INSERT OR UPDATE ON participant_import_jobs
FOR EACH ROW EXECUTE FUNCTION enforce_job_detail_contract();

CREATE TRIGGER certificate_generation_job_contract_trg
BEFORE INSERT OR UPDATE ON certificate_generation_jobs
FOR EACH ROW EXECUTE FUNCTION enforce_job_detail_contract();

CREATE FUNCTION enforce_import_training_contract()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    import_training_id UUID;
BEGIN
    IF NEW.source_import_job_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT training_id INTO import_training_id
    FROM participant_import_jobs
    WHERE job_id = NEW.source_import_job_id
      AND organization_id = NEW.organization_id;

    IF import_training_id IS DISTINCT FROM NEW.training_id THEN
        RAISE EXCEPTION 'participant import job and training participant must use the same training';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER training_participant_import_contract_trg
BEFORE INSERT OR UPDATE ON training_participants
FOR EACH ROW EXECUTE FUNCTION enforce_import_training_contract();

CREATE FUNCTION enforce_certificate_template_contract()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    version_status template_version_status;
BEGIN
    SELECT status INTO version_status
    FROM template_versions
    WHERE id = NEW.template_version_id
      AND organization_id = NEW.organization_id;

    IF version_status <> 'PUBLISHED' THEN
        RAISE EXCEPTION 'new certificates require a published template version';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER certificate_template_contract_trg
BEFORE INSERT OR UPDATE OF template_version_id, organization_id ON certificates
FOR EACH ROW EXECUTE FUNCTION enforce_certificate_template_contract();

CREATE FUNCTION enforce_generation_item_contract()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    certificate_training_id UUID;
    certificate_template_version_id UUID;
    job_training_id UUID;
    job_template_version_id UUID;
    job_revision INTEGER;
BEGIN
    SELECT training_id, template_version_id
      INTO certificate_training_id, certificate_template_version_id
    FROM certificates
    WHERE id = NEW.certificate_id
      AND organization_id = NEW.organization_id;

    SELECT training_id, template_version_id, generation_revision
      INTO job_training_id, job_template_version_id, job_revision
    FROM certificate_generation_jobs
    WHERE job_id = NEW.job_id
      AND organization_id = NEW.organization_id;

    IF certificate_training_id IS DISTINCT FROM job_training_id
       OR certificate_template_version_id IS DISTINCT FROM job_template_version_id
       OR NEW.generation_revision IS DISTINCT FROM job_revision THEN
        RAISE EXCEPTION 'generation item must match the job training, template version and revision';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER certificate_generation_item_contract_trg
BEFORE INSERT OR UPDATE ON certificate_generation_items
FOR EACH ROW EXECUTE FUNCTION enforce_generation_item_contract();

CREATE FUNCTION protect_certificate_public_identifier()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.public_identifier IS DISTINCT FROM OLD.public_identifier THEN
        RAISE EXCEPTION 'certificate public identifier is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER certificate_public_identifier_trg
BEFORE UPDATE OF public_identifier ON certificates
FOR EACH ROW EXECUTE FUNCTION protect_certificate_public_identifier();

CREATE FUNCTION reject_audit_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'audit logs are append-only';
END;
$$;

CREATE TRIGGER audit_logs_append_only_trg
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();

-- The signed verification token itself is intentionally absent. The database
-- stores the non-secret public identifier and current certificate state only.
