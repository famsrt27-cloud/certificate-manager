import type { MigrationBuilder } from "node-pg-migrate";

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    ALTER TABLE certificate_issuance_snapshots
      ADD COLUMN issued_at TIMESTAMPTZ;

    UPDATE certificate_issuance_snapshots AS snapshot
    SET issued_at = COALESCE(certificate.issued_at, snapshot.created_at)
    FROM certificates AS certificate
    WHERE certificate.id = snapshot.certificate_id
      AND certificate.organization_id = snapshot.organization_id;

    ALTER TABLE certificate_issuance_snapshots
      ALTER COLUMN issued_at SET NOT NULL;

    ALTER TABLE certificate_generation_jobs
      ADD COLUMN selection_mode TEXT,
      ADD COLUMN request_fingerprint BYTEA,
      ADD COLUMN renderer_revision TEXT;

    UPDATE certificate_generation_jobs
    SET selection_mode = 'EXPLICIT',
        request_fingerprint = digest('legacy-pre-phase5:' || job_id::text, 'sha256'),
        renderer_revision = 'legacy-pre-phase5';

    ALTER TABLE certificate_generation_jobs
      ALTER COLUMN selection_mode SET NOT NULL,
      ALTER COLUMN request_fingerprint SET NOT NULL,
      ALTER COLUMN renderer_revision SET NOT NULL,
      ADD CONSTRAINT certificate_generation_selection_mode_ck
        CHECK (selection_mode IN ('ALL_ELIGIBLE', 'EXPLICIT')),
      ADD CONSTRAINT certificate_generation_request_fingerprint_ck
        CHECK (octet_length(request_fingerprint) = 32),
      ADD CONSTRAINT certificate_generation_renderer_revision_ck
        CHECK (
          renderer_revision ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
        );

    DO $generation_duplicate_precheck$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM certificates
        WHERE status <> 'REVOKED'
        GROUP BY organization_id, training_id, participant_id
        HAVING count(*) > 1
      ) THEN
        RAISE EXCEPTION
          'pre-Phase 5 certificate data contains multiple non-revoked certificates for one training participant; remove synthetic fixtures or reconcile the data before applying this migration'
          USING ERRCODE = 'P0001';
      END IF;
    END;
    $generation_duplicate_precheck$;

    CREATE UNIQUE INDEX certificates_one_non_revoked_per_training_participant_idx
      ON certificates (organization_id, training_id, participant_id)
      WHERE status <> 'REVOKED';

    CREATE FUNCTION enforce_certificate_publication_issued_at_snapshot()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $certificate_issued_at_snapshot$
    DECLARE
      planned_issued_at TIMESTAMPTZ;
    BEGIN
      IF OLD.status = 'GENERATING' AND NEW.status = 'AVAILABLE' THEN
        SELECT issued_at
          INTO planned_issued_at
        FROM certificate_issuance_snapshots
        WHERE certificate_id = OLD.id
          AND organization_id = OLD.organization_id;

        IF planned_issued_at IS NULL
           OR NEW.issued_at IS DISTINCT FROM planned_issued_at THEN
          RAISE EXCEPTION 'certificate publication issue time must match the immutable issuance snapshot'
            USING ERRCODE = 'P0001';
        END IF;
      END IF;

      RETURN NEW;
    END;
    $certificate_issued_at_snapshot$;

    CREATE TRIGGER certificate_publication_issued_at_snapshot_trg
    BEFORE UPDATE ON certificates
    FOR EACH ROW EXECUTE FUNCTION enforce_certificate_publication_issued_at_snapshot();
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS certificate_publication_issued_at_snapshot_trg ON certificates;
    DROP FUNCTION IF EXISTS enforce_certificate_publication_issued_at_snapshot();

    DROP INDEX IF EXISTS certificates_one_non_revoked_per_training_participant_idx;

    ALTER TABLE certificate_generation_jobs
      DROP CONSTRAINT IF EXISTS certificate_generation_renderer_revision_ck,
      DROP CONSTRAINT IF EXISTS certificate_generation_request_fingerprint_ck,
      DROP CONSTRAINT IF EXISTS certificate_generation_selection_mode_ck,
      DROP COLUMN IF EXISTS renderer_revision,
      DROP COLUMN IF EXISTS request_fingerprint,
      DROP COLUMN IF EXISTS selection_mode;

    ALTER TABLE certificate_issuance_snapshots
      DROP COLUMN IF EXISTS issued_at;
  `);
};
