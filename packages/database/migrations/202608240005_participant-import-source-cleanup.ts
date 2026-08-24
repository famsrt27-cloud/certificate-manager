import type { MigrationBuilder } from "node-pg-migrate";

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    ALTER TABLE participant_import_jobs
      ADD COLUMN source_cleanup_requested_at TIMESTAMPTZ,
      ADD COLUMN source_cleanup_completed_at TIMESTAMPTZ,
      ADD COLUMN source_cleanup_attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (source_cleanup_attempt_count >= 0),
      ADD COLUMN source_cleanup_last_attempt_at TIMESTAMPTZ,
      ADD COLUMN source_cleanup_last_error_code TEXT,
      ADD COLUMN retention_cleanup_completed_at TIMESTAMPTZ,
      ADD CONSTRAINT participant_import_source_cleanup_state_ck
        CHECK (
          source_cleanup_completed_at IS NULL
          OR source_cleanup_requested_at IS NOT NULL
        );

    CREATE INDEX participant_import_source_cleanup_pending_idx
      ON participant_import_jobs (
        source_cleanup_requested_at,
        source_cleanup_last_attempt_at,
        job_id
      )
      WHERE source_cleanup_requested_at IS NOT NULL
        AND source_cleanup_completed_at IS NULL;

    UPDATE participant_import_jobs AS detail
    SET source_cleanup_requested_at = now()
    FROM jobs AS job
    WHERE job.id = detail.job_id
      AND job.organization_id = detail.organization_id
      AND job.status IN (
        'AWAITING_CONFIRMATION',
        'SUCCEEDED',
        'FAILED',
        'DEAD_LETTER',
        'CANCELLED'
      );
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DROP INDEX IF EXISTS participant_import_source_cleanup_pending_idx;
    ALTER TABLE participant_import_jobs
      DROP CONSTRAINT IF EXISTS participant_import_source_cleanup_state_ck,
      DROP COLUMN IF EXISTS retention_cleanup_completed_at,
      DROP COLUMN IF EXISTS source_cleanup_last_error_code,
      DROP COLUMN IF EXISTS source_cleanup_last_attempt_at,
      DROP COLUMN IF EXISTS source_cleanup_attempt_count,
      DROP COLUMN IF EXISTS source_cleanup_completed_at,
      DROP COLUMN IF EXISTS source_cleanup_requested_at;
  `);
};
