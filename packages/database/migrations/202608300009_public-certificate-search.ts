import type { MigrationBuilder } from "node-pg-migrate";

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    ALTER TABLE organizations
      ADD COLUMN public_certificate_search_enabled BOOLEAN NOT NULL DEFAULT FALSE;

    CREATE INDEX certificates_public_search_number_idx
      ON certificates (lower(regexp_replace(normalize(btrim(certificate_number), NFKC), '[[:space:]]+', ' ', 'g')))
      WHERE status = 'AVAILABLE';
    CREATE INDEX certificate_snapshots_public_recipient_project_idx
      ON certificate_issuance_snapshots
      (lower(regexp_replace(normalize(btrim(recipient_display_name), NFKC), '[[:space:]]+', ' ', 'g')),
       lower(regexp_replace(normalize(btrim(project_name), NFKC), '[[:space:]]+', ' ', 'g')), certificate_id);
    CREATE INDEX certificate_snapshots_public_recipient_training_idx
      ON certificate_issuance_snapshots
      (lower(regexp_replace(normalize(btrim(recipient_display_name), NFKC), '[[:space:]]+', ' ', 'g')),
       lower(regexp_replace(normalize(btrim(training_name), NFKC), '[[:space:]]+', ' ', 'g')), certificate_id);
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DROP INDEX IF EXISTS certificate_snapshots_public_recipient_training_idx;
    DROP INDEX IF EXISTS certificate_snapshots_public_recipient_project_idx;
    DROP INDEX IF EXISTS certificates_public_search_number_idx;
    ALTER TABLE organizations DROP COLUMN public_certificate_search_enabled;
  `);
};
