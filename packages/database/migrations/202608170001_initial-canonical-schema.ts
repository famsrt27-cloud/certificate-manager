import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { MigrationBuilder } from "node-pg-migrate";

const SCHEMA_URL = new URL("../schema/0001-canonical-schema.sql", import.meta.url);
const EXPECTED_SCHEMA_SHA256 = "1353deed1f285e8f30b713b76c3d7c0b0d79f2c3145ce5fc13bacb77ecd969a0";

const readCanonicalSchema = (): string => {
  const schema = readFileSync(SCHEMA_URL, "utf8");
  const actualHash = createHash("sha256").update(schema).digest("hex");

  if (actualHash !== EXPECTED_SCHEMA_SHA256) {
    throw new Error("Canonical schema snapshot checksum mismatch");
  }

  return schema;
};

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(readCanonicalSchema());
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DROP TABLE IF EXISTS download_events, verification_events, audit_logs,
      certificate_generation_items, certificates, certificate_generation_jobs,
      training_participants, participant_import_rows, participant_import_jobs,
      jobs, template_version_assets, template_versions, template_assets,
      certificate_templates, participants, trainings, projects, membership_roles,
      user_system_roles, role_permissions, permissions, roles,
      organization_memberships, users, organizations CASCADE;

    DROP FUNCTION IF EXISTS reject_audit_log_mutation();
    DROP FUNCTION IF EXISTS protect_certificate_public_identifier();
    DROP FUNCTION IF EXISTS enforce_generation_item_contract();
    DROP FUNCTION IF EXISTS enforce_certificate_template_contract();
    DROP FUNCTION IF EXISTS enforce_import_training_contract();
    DROP FUNCTION IF EXISTS enforce_job_detail_contract();
    DROP FUNCTION IF EXISTS protect_published_template_asset_content();
    DROP FUNCTION IF EXISTS enforce_template_version_asset_mutability();
    DROP FUNCTION IF EXISTS enforce_template_version_immutability();

    DROP TYPE IF EXISTS template_asset_status;
    DROP TYPE IF EXISTS import_row_status;
    DROP TYPE IF EXISTS job_item_status;
    DROP TYPE IF EXISTS job_status;
    DROP TYPE IF EXISTS job_type;
    DROP TYPE IF EXISTS role_code;
    DROP TYPE IF EXISTS template_version_status;
    DROP TYPE IF EXISTS certificate_status;
    DROP TYPE IF EXISTS record_status;
  `);
};
