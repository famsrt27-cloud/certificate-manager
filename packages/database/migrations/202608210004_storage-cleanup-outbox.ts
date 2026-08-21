import type { MigrationBuilder } from "node-pg-migrate";

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE storage_cleanup_outbox (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL REFERENCES organizations(id),
      object_key TEXT NOT NULL UNIQUE,
      not_before TIMESTAMPTZ NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_attempt_at TIMESTAMPTZ,
      last_error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX storage_cleanup_outbox_due_idx
      ON storage_cleanup_outbox(not_before, created_at, id);
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql("DROP TABLE IF EXISTS storage_cleanup_outbox;");
};
