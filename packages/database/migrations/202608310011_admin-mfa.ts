import type { MigrationBuilder } from "node-pg-migrate";

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE admin_mfa_factors (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      encrypted_totp_secret TEXT NOT NULL,
      recovery_code_hashes TEXT[] NOT NULL,
      last_accepted_timestep BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT admin_mfa_factors_recovery_count_chk CHECK (cardinality(recovery_code_hashes) <= 10),
      CONSTRAINT admin_mfa_factors_encrypted_secret_chk CHECK (length(encrypted_totp_secret) BETWEEN 40 AND 512)
    );
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql("DROP TABLE IF EXISTS admin_mfa_factors;");
};
