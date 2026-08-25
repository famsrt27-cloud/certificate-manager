import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { runner } from "node-pg-migrate";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const enabled = testDatabaseUrl !== undefined && new URL(testDatabaseUrl).pathname.toLowerCase().includes("test");

describe.skipIf(!enabled)("certificate verification key migration 008", () => {
  const temporaryDatabaseName = `certificate_migration_008_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = new URL(testDatabaseUrl!);
  const temporaryUrl = new URL(testDatabaseUrl!);
  temporaryUrl.pathname = `/${temporaryDatabaseName}`;
  const admin = new Client({ connectionString: adminUrl.toString() });
  let database: Client;
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const trainingId = randomUUID();
  const templateId = randomUUID();
  const templateVersionId = randomUUID();
  const legacyParticipantId = randomUUID();
  const legacyCertificateId = randomUUID();

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${temporaryDatabaseName}`);
    await runner({
      databaseUrl: temporaryUrl.toString(),
      dir: resolve("packages/database/migrations"),
      direction: "up",
      count: 7,
      migrationsTable: "pgmigrations",
      log: () => undefined
    });
    database = new Client({ connectionString: temporaryUrl.toString() });
    await database.connect();
    await database.query("INSERT INTO organizations (id, name) VALUES ($1, $2)", [organizationId, "Migration 008 Tenant"]);
    await database.query("INSERT INTO projects (id, organization_id, name, slug) VALUES ($1, $2, $3, $4)",
      [projectId, organizationId, "Legacy Project", `legacy-${randomUUID()}`]);
    await database.query("INSERT INTO trainings (id, organization_id, project_id, name, code) VALUES ($1, $2, $3, $4, $5)",
      [trainingId, organizationId, projectId, "Legacy Training", `LEGACY-${randomUUID()}`]);
    await database.query("INSERT INTO participants (id, organization_id, display_name) VALUES ($1, $2, $3)",
      [legacyParticipantId, organizationId, "Legacy Recipient"]);
    await database.query("INSERT INTO training_participants (organization_id, training_id, participant_id) VALUES ($1, $2, $3)",
      [organizationId, trainingId, legacyParticipantId]);
    await database.query("INSERT INTO certificate_templates (id, organization_id, name) VALUES ($1, $2, $3)",
      [templateId, organizationId, "Legacy Template"]);
    await database.query("INSERT INTO template_versions (id, organization_id, template_id, version, definition_json, status, published_at) VALUES ($1, $2, $3, 1, $4, 'PUBLISHED', now())",
      [templateVersionId, organizationId, templateId, { format_version: 1 }]);
    await database.query("INSERT INTO certificates (id, organization_id, training_id, participant_id, template_version_id, certificate_number) VALUES ($1, $2, $3, $4, $5, $6)",
      [legacyCertificateId, organizationId, trainingId, legacyParticipantId, templateVersionId, `LEGACY-${randomUUID()}`]);
    await database.end();
    await runner({
      databaseUrl: temporaryUrl.toString(),
      dir: resolve("packages/database/migrations"),
      direction: "up",
      count: 1,
      migrationsTable: "pgmigrations",
      log: () => undefined
    });
    database = new Client({ connectionString: temporaryUrl.toString() });
    await database.connect();
  }, 30_000);

  afterAll(async () => {
    await database.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${temporaryDatabaseName} WITH (FORCE)`);
    await admin.end();
  });

  it("preserves legacy null keys and enforces immutable keys for new certificates", async () => {
    const legacy = await database.query("SELECT verification_key_kid FROM certificates WHERE id = $1", [legacyCertificateId]);
    expect(legacy.rows[0]?.verification_key_kid).toBeNull();
    await database.query("UPDATE certificates SET updated_at = now() WHERE id = $1", [legacyCertificateId]);
    expect((await database.query("SELECT verification_key_kid FROM certificates WHERE id = $1", [legacyCertificateId])).rows[0]?.verification_key_kid).toBeNull();
    await expect(database.query("UPDATE certificates SET verification_key_kid = $2 WHERE id = $1", [legacyCertificateId, "legacy-adoption"])).rejects.toMatchObject({ code: "P0001" });

    const participantWithoutKid = randomUUID();
    await database.query("INSERT INTO participants (id, organization_id, display_name) VALUES ($1, $2, $3)", [participantWithoutKid, organizationId, "No Kid"]);
    await database.query("INSERT INTO training_participants (organization_id, training_id, participant_id) VALUES ($1, $2, $3)", [organizationId, trainingId, participantWithoutKid]);
    await expect(database.query("INSERT INTO certificates (organization_id, training_id, participant_id, template_version_id, certificate_number) VALUES ($1, $2, $3, $4, $5)",
      [organizationId, trainingId, participantWithoutKid, templateVersionId, `NO-KID-${randomUUID()}`])).rejects.toMatchObject({ code: "P0001" });

    const participantWithKid = randomUUID();
    await database.query("INSERT INTO participants (id, organization_id, display_name) VALUES ($1, $2, $3)", [participantWithKid, organizationId, "With Kid"]);
    await database.query("INSERT INTO training_participants (organization_id, training_id, participant_id) VALUES ($1, $2, $3)", [organizationId, trainingId, participantWithKid]);
    const inserted = await database.query("INSERT INTO certificates (organization_id, training_id, participant_id, template_version_id, certificate_number, verification_key_kid) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, verification_key_kid",
      [organizationId, trainingId, participantWithKid, templateVersionId, `WITH-KID-${randomUUID()}`, "key-2026-01"]);
    expect(inserted.rows[0]?.verification_key_kid).toBe("key-2026-01");
    await expect(database.query("UPDATE certificates SET verification_key_kid = $2 WHERE id = $1", [inserted.rows[0]?.id, "key-2026-02"])).rejects.toMatchObject({ code: "P0001" });
  });
});
