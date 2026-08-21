import type { MigrationBuilder } from "node-pg-migrate";

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE queue_outbox (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL REFERENCES organizations(id),
      message_type TEXT NOT NULL,
      deduplication_key TEXT NOT NULL,
      payload_json JSONB NOT NULL,
      dispatched_at TIMESTAMPTZ,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_attempt_at TIMESTAMPTZ,
      last_error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (organization_id, message_type, deduplication_key)
    );

    CREATE INDEX queue_outbox_pending_idx
      ON queue_outbox(created_at, id)
      WHERE dispatched_at IS NULL;

    INSERT INTO queue_outbox (
      organization_id,
      message_type,
      deduplication_key,
      payload_json
    )
    SELECT
      job.organization_id,
      CASE
        WHEN detail.confirmed_at IS NULL THEN 'PARTICIPANT_IMPORT_VALIDATE'
        ELSE 'PARTICIPANT_IMPORT_CONFIRM'
      END,
      job.id::text || CASE
        WHEN detail.confirmed_at IS NULL THEN '-validate'
        ELSE '-confirm'
      END,
      jsonb_build_object(
        'version', 1,
        'job_id', job.id,
        'organization_id', job.organization_id,
        'operation', CASE
          WHEN detail.confirmed_at IS NULL THEN 'VALIDATE'
          ELSE 'CONFIRM'
        END
      )
    FROM jobs AS job
    INNER JOIN participant_import_jobs AS detail
      ON detail.job_id = job.id
      AND detail.organization_id = job.organization_id
    WHERE job.job_type = 'PARTICIPANT_IMPORT'
      AND job.status = 'QUEUED'
    ON CONFLICT (organization_id, message_type, deduplication_key) DO NOTHING;
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql("DROP TABLE IF EXISTS queue_outbox;");
};
