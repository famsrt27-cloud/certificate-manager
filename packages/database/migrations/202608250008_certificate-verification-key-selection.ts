import type { MigrationBuilder } from "node-pg-migrate";

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    ALTER TABLE certificates ADD COLUMN verification_key_kid TEXT NULL
      CHECK (verification_key_kid IS NULL OR verification_key_kid ~ '^[A-Za-z0-9._-]{1,128}$');
    CREATE FUNCTION enforce_certificate_verification_key_selection()
    RETURNS trigger LANGUAGE plpgsql AS $verification_kid$
    BEGIN
      IF TG_OP = 'INSERT' AND NEW.verification_key_kid IS NULL THEN
        RAISE EXCEPTION 'new certificates require an immutable verification signing key selection' USING ERRCODE = 'P0001';
      END IF;
      IF TG_OP = 'UPDATE' AND NEW.verification_key_kid IS DISTINCT FROM OLD.verification_key_kid THEN
        RAISE EXCEPTION 'certificate verification signing key selection is immutable' USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END;
    $verification_kid$;
    CREATE TRIGGER certificate_verification_key_selection_trg
    BEFORE INSERT OR UPDATE OF verification_key_kid ON certificates
    FOR EACH ROW EXECUTE FUNCTION enforce_certificate_verification_key_selection();
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS certificate_verification_key_selection_trg ON certificates;
    DROP FUNCTION IF EXISTS enforce_certificate_verification_key_selection();
    ALTER TABLE certificates DROP COLUMN verification_key_kid;
  `);
};
