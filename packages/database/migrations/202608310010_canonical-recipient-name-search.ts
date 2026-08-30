import type { MigrationBuilder } from "node-pg-migrate";

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE FUNCTION public.canonical_public_recipient_name(input_name TEXT, remove_leading_title BOOLEAN DEFAULT FALSE)
    RETURNS TEXT
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
    STRICT
    SET search_path = pg_catalog, pg_temp
    AS $function$
      WITH normalized(value) AS (
        SELECT lower(regexp_replace(normalize(btrim(input_name), NFKC), '[[:space:]]+', ' ', 'g'))
      ), recognized(value, parts) AS (
        SELECT value, regexp_match(
          value,
          '^((นางสาว|เด็กชาย|เด็กหญิง|นาย|นาง)|(ด[[:space:]]*[.][[:space:]]*ช[[:space:]]*[.])|(ด[[:space:]]*[.][[:space:]]*ญ[[:space:]]*[.]))[[:space:]]*(.*)$'
        )
        FROM normalized
      )
      SELECT CASE
        WHEN parts IS NULL THEN value
        WHEN remove_leading_title THEN parts[5]
        WHEN parts[3] IS NOT NULL THEN 'เด็กชาย' || parts[5]
        WHEN parts[4] IS NOT NULL THEN 'เด็กหญิง' || parts[5]
        ELSE parts[2] || parts[5]
      END
      FROM recognized;
    $function$;

    DROP INDEX certificate_snapshots_public_recipient_project_idx;
    DROP INDEX certificate_snapshots_public_recipient_training_idx;

    CREATE INDEX certificate_snapshots_public_name_full_project_idx
      ON certificate_issuance_snapshots
      (public.canonical_public_recipient_name(recipient_display_name, FALSE),
       lower(regexp_replace(normalize(btrim(project_name), NFKC), '[[:space:]]+', ' ', 'g')), certificate_id);
    CREATE INDEX certificate_snapshots_public_name_base_project_idx
      ON certificate_issuance_snapshots
      (public.canonical_public_recipient_name(recipient_display_name, TRUE),
       lower(regexp_replace(normalize(btrim(project_name), NFKC), '[[:space:]]+', ' ', 'g')), certificate_id);
    CREATE INDEX certificate_snapshots_public_name_full_training_idx
      ON certificate_issuance_snapshots
      (public.canonical_public_recipient_name(recipient_display_name, FALSE),
       lower(regexp_replace(normalize(btrim(training_name), NFKC), '[[:space:]]+', ' ', 'g')), certificate_id);
    CREATE INDEX certificate_snapshots_public_name_base_training_idx
      ON certificate_issuance_snapshots
      (public.canonical_public_recipient_name(recipient_display_name, TRUE),
       lower(regexp_replace(normalize(btrim(training_name), NFKC), '[[:space:]]+', ' ', 'g')), certificate_id);
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DROP INDEX IF EXISTS certificate_snapshots_public_name_base_training_idx;
    DROP INDEX IF EXISTS certificate_snapshots_public_name_full_training_idx;
    DROP INDEX IF EXISTS certificate_snapshots_public_name_base_project_idx;
    DROP INDEX IF EXISTS certificate_snapshots_public_name_full_project_idx;
    DROP FUNCTION IF EXISTS public.canonical_public_recipient_name(TEXT, BOOLEAN);

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
