import type { MigrationBuilder } from "node-pg-migrate";

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE certificate_issuance_snapshots (
      certificate_id UUID PRIMARY KEY,
      organization_id UUID NOT NULL,
      snapshot_schema_version INTEGER NOT NULL DEFAULT 1
        CHECK (snapshot_schema_version = 1),
      recipient_display_name TEXT NOT NULL
        CHECK (char_length(btrim(recipient_display_name)) BETWEEN 1 AND 500),
      project_name TEXT NOT NULL
        CHECK (char_length(btrim(project_name)) BETWEEN 1 AND 500),
      training_name TEXT NOT NULL
        CHECK (char_length(btrim(training_name)) BETWEEN 1 AND 500),
      training_code TEXT NOT NULL
        CHECK (char_length(btrim(training_code)) BETWEEN 1 AND 200),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (certificate_id, organization_id),
      FOREIGN KEY (certificate_id, organization_id)
        REFERENCES certificates(id, organization_id)
    );

    CREATE FUNCTION enforce_certificate_issuance_snapshot_contract()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $certificate_snapshot_contract$
    DECLARE
      parent_status certificate_status;
    BEGIN
      IF TG_OP IN ('UPDATE', 'DELETE') THEN
        RAISE EXCEPTION 'certificate issuance snapshots are immutable'
          USING ERRCODE = 'P0001';
      END IF;

      SELECT status
        INTO parent_status
      FROM certificates
      WHERE id = NEW.certificate_id
        AND organization_id = NEW.organization_id;

      IF parent_status IS NULL THEN
        RAISE EXCEPTION 'certificate issuance snapshot requires an existing certificate'
          USING ERRCODE = 'P0001';
      END IF;

      IF parent_status <> 'DRAFT' THEN
        RAISE EXCEPTION 'certificate issuance snapshot must be captured while the certificate is draft'
          USING ERRCODE = 'P0001';
      END IF;

      RETURN NEW;
    END;
    $certificate_snapshot_contract$;

    CREATE TRIGGER certificate_issuance_snapshot_contract_trg
    BEFORE INSERT OR UPDATE OR DELETE ON certificate_issuance_snapshots
    FOR EACH ROW EXECUTE FUNCTION enforce_certificate_issuance_snapshot_contract();

    CREATE FUNCTION protect_certificate_generation_job_inputs()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $generation_job_inputs$
    BEGIN
      RAISE EXCEPTION 'certificate generation job inputs are immutable'
        USING ERRCODE = 'P0001';
    END;
    $generation_job_inputs$;

    CREATE TRIGGER certificate_generation_job_inputs_trg
    BEFORE UPDATE OR DELETE ON certificate_generation_jobs
    FOR EACH ROW EXECUTE FUNCTION protect_certificate_generation_job_inputs();

    CREATE OR REPLACE FUNCTION enforce_generation_item_contract()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $generation_item_contract$
    DECLARE
      certificate_training_id UUID;
      certificate_template_version_id UUID;
      certificate_revision INTEGER;
      certificate_state certificate_status;
      job_training_id UUID;
      job_template_version_id UUID;
      job_revision INTEGER;
    BEGIN
      SELECT training_id, template_version_id, generation_revision, status
        INTO certificate_training_id, certificate_template_version_id, certificate_revision, certificate_state
      FROM certificates
      WHERE id = NEW.certificate_id
        AND organization_id = NEW.organization_id;

      SELECT training_id, template_version_id, generation_revision
        INTO job_training_id, job_template_version_id, job_revision
      FROM certificate_generation_jobs
      WHERE job_id = NEW.job_id
        AND organization_id = NEW.organization_id;

      IF certificate_training_id IS NULL OR job_training_id IS NULL THEN
        RAISE EXCEPTION 'generation item requires existing certificate and generation job'
          USING ERRCODE = 'P0001';
      END IF;

      IF certificate_training_id IS DISTINCT FROM job_training_id
         OR certificate_template_version_id IS DISTINCT FROM job_template_version_id
         OR NEW.generation_revision IS DISTINCT FROM job_revision THEN
        RAISE EXCEPTION 'generation item must match the job training, template version and revision'
          USING ERRCODE = 'P0001';
      END IF;

      IF certificate_state IN ('DRAFT', 'GENERATING') THEN
        IF job_revision IS DISTINCT FROM certificate_revision THEN
          RAISE EXCEPTION 'initial generation item must match the current certificate revision'
            USING ERRCODE = 'P0001';
        END IF;
      ELSIF certificate_state = 'AVAILABLE' THEN
        IF job_revision IS DISTINCT FROM certificate_revision + 1 THEN
          RAISE EXCEPTION 'regeneration item must target exactly the next certificate revision'
            USING ERRCODE = 'P0001';
        END IF;
      ELSE
        RAISE EXCEPTION 'certificate state does not accept generation work'
          USING ERRCODE = 'P0001';
      END IF;

      RETURN NEW;
    END;
    $generation_item_contract$;

    CREATE FUNCTION enforce_certificate_integrity()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $certificate_integrity$
    DECLARE
      pdf_changed BOOLEAN;
      publication BOOLEAN;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'certificate records are durable and cannot be deleted'
          USING ERRCODE = 'P0001';
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'DRAFT'
           OR NEW.generation_revision <> 1
           OR NEW.pdf_storage_key IS NOT NULL
           OR NEW.pdf_content_sha256 IS NOT NULL
           OR NEW.pdf_size_bytes IS NOT NULL
           OR NEW.pdf_mime_type IS NOT NULL
           OR NEW.issued_at IS NOT NULL
           OR NEW.revoked_at IS NOT NULL
           OR NEW.revocation_reason IS NOT NULL THEN
          RAISE EXCEPTION 'new certificates must begin as clean revision-1 drafts'
            USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END IF;

      IF NEW.public_identifier IS DISTINCT FROM OLD.public_identifier
         OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
         OR NEW.training_id IS DISTINCT FROM OLD.training_id
         OR NEW.participant_id IS DISTINCT FROM OLD.participant_id
         OR NEW.template_version_id IS DISTINCT FROM OLD.template_version_id
         OR NEW.certificate_number IS DISTINCT FROM OLD.certificate_number THEN
        RAISE EXCEPTION 'certificate issuance identity is immutable'
          USING ERRCODE = 'P0001';
      END IF;

      IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF OLD.status = 'DRAFT' AND NEW.status = 'GENERATING' THEN
          IF NOT EXISTS (
            SELECT 1
            FROM certificate_issuance_snapshots snapshot
            WHERE snapshot.certificate_id = OLD.id
              AND snapshot.organization_id = OLD.organization_id
          ) THEN
            RAISE EXCEPTION 'certificate generation requires an immutable issuance snapshot'
              USING ERRCODE = 'P0001';
          END IF;
        ELSIF OLD.status = 'GENERATING' AND NEW.status = 'AVAILABLE' THEN
          NULL;
        ELSIF OLD.status = 'AVAILABLE' AND NEW.status = 'REVOKED' THEN
          NULL;
        ELSE
          RAISE EXCEPTION 'invalid certificate lifecycle transition'
            USING ERRCODE = 'P0001';
        END IF;
      END IF;

      IF NEW.generation_revision IS DISTINCT FROM OLD.generation_revision THEN
        IF NOT (
          OLD.status = 'AVAILABLE'
          AND NEW.status = 'AVAILABLE'
          AND NEW.generation_revision = OLD.generation_revision + 1
        ) THEN
          RAISE EXCEPTION 'certificate generation revisions may only advance one step during atomic regeneration publication'
            USING ERRCODE = 'P0001';
        END IF;
      END IF;

      pdf_changed :=
        NEW.pdf_storage_key IS DISTINCT FROM OLD.pdf_storage_key
        OR NEW.pdf_content_sha256 IS DISTINCT FROM OLD.pdf_content_sha256
        OR NEW.pdf_size_bytes IS DISTINCT FROM OLD.pdf_size_bytes
        OR NEW.pdf_mime_type IS DISTINCT FROM OLD.pdf_mime_type;

      publication :=
        (
          OLD.status = 'GENERATING'
          AND NEW.status = 'AVAILABLE'
          AND NEW.generation_revision = OLD.generation_revision
        )
        OR (
          OLD.status = 'AVAILABLE'
          AND NEW.status = 'AVAILABLE'
          AND NEW.generation_revision = OLD.generation_revision + 1
        );

      IF pdf_changed AND NOT publication THEN
        RAISE EXCEPTION 'certificate PDF identity may change only when publishing a completed generation revision'
          USING ERRCODE = 'P0001';
      END IF;

      IF NEW.generation_revision IS DISTINCT FROM OLD.generation_revision AND NOT pdf_changed THEN
        RAISE EXCEPTION 'a new certificate revision requires new PDF integrity metadata'
          USING ERRCODE = 'P0001';
      END IF;

      IF NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
        IF NOT (
          OLD.status = 'GENERATING'
          AND NEW.status = 'AVAILABLE'
          AND OLD.issued_at IS NULL
          AND NEW.issued_at IS NOT NULL
        ) THEN
          RAISE EXCEPTION 'certificate issue time is immutable after initial publication'
            USING ERRCODE = 'P0001';
        END IF;
      END IF;

      IF OLD.status = 'REVOKED' AND (
        NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
        OR NEW.revocation_reason IS DISTINCT FROM OLD.revocation_reason
      ) THEN
        RAISE EXCEPTION 'certificate revocation metadata is immutable'
          USING ERRCODE = 'P0001';
      END IF;

      IF NEW.status = 'REVOKED' THEN
        IF NEW.revoked_at IS NULL
           OR NEW.revocation_reason IS NULL
           OR char_length(btrim(NEW.revocation_reason)) = 0 THEN
          RAISE EXCEPTION 'revoked certificates require immutable revocation metadata'
            USING ERRCODE = 'P0001';
        END IF;
      ELSIF NEW.revoked_at IS NOT NULL OR NEW.revocation_reason IS NOT NULL THEN
        RAISE EXCEPTION 'revocation metadata is allowed only for revoked certificates'
          USING ERRCODE = 'P0001';
      END IF;

      IF publication AND NOT EXISTS (
        SELECT 1
        FROM certificate_generation_items item
        JOIN certificate_generation_jobs detail
          ON detail.job_id = item.job_id
         AND detail.organization_id = item.organization_id
        WHERE item.certificate_id = OLD.id
          AND item.organization_id = OLD.organization_id
          AND item.generation_revision = NEW.generation_revision
          AND item.status = 'SUCCEEDED'
          AND detail.training_id = OLD.training_id
          AND detail.template_version_id = OLD.template_version_id
          AND detail.generation_revision = NEW.generation_revision
      ) THEN
        RAISE EXCEPTION 'certificate publication requires a succeeded generation item for the same revision'
          USING ERRCODE = 'P0001';
      END IF;

      RETURN NEW;
    END;
    $certificate_integrity$;

    CREATE TRIGGER certificate_integrity_trg
    BEFORE INSERT OR UPDATE OR DELETE ON certificates
    FOR EACH ROW EXECUTE FUNCTION enforce_certificate_integrity();
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS certificate_integrity_trg ON certificates;
    DROP FUNCTION IF EXISTS enforce_certificate_integrity();

    DROP TRIGGER IF EXISTS certificate_generation_job_inputs_trg ON certificate_generation_jobs;
    DROP FUNCTION IF EXISTS protect_certificate_generation_job_inputs();

    DROP TRIGGER IF EXISTS certificate_issuance_snapshot_contract_trg ON certificate_issuance_snapshots;
    DROP FUNCTION IF EXISTS enforce_certificate_issuance_snapshot_contract();

    DROP TABLE IF EXISTS certificate_issuance_snapshots;

    CREATE OR REPLACE FUNCTION enforce_generation_item_contract()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $generation_item_contract_restore$
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
    $generation_item_contract_restore$;
  `);
};
