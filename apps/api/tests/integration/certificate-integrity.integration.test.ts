import { randomUUID } from "node:crypto";

import { closeDatabase, createDatabase } from "@certificate-platform/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationEnabled = databaseUrl !== undefined
  && new URL(databaseUrl).pathname.toLowerCase().includes("test");
const plannedIssuedAt = new Date("2026-08-24T07:00:00.000Z");

describe.skipIf(!integrationEnabled)("certificate integrity PostgreSQL integration", () => {
  const database = createDatabase({ connectionString: databaseUrl!, maxConnections: 2 });
  const organizationId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const projectId = randomUUID();
  const trainingId = randomUUID();
  const baselineParticipantId = randomUUID();
  const templateId = randomUUID();
  const templateVersionId = randomUUID();

  beforeAll(async () => {
    await database.insertInto("organizations").values({
      id: organizationId,
      name: "Certificate Integrity Tenant"
    }).execute();

    await database.insertInto("users").values({
      id: userId,
      email: `certificate-integrity-${randomUUID()}@example.invalid`,
      password_hash: "synthetic"
    }).execute();

    await database.insertInto("organization_memberships").values({
      id: membershipId,
      organization_id: organizationId,
      user_id: userId
    }).execute();

    await database.insertInto("projects").values({
      id: projectId,
      organization_id: organizationId,
      name: "Original Project",
      slug: `certificate-integrity-${randomUUID()}`
    }).execute();

    await database.insertInto("trainings").values({
      id: trainingId,
      organization_id: organizationId,
      project_id: projectId,
      name: "Original Training",
      code: `TRAIN-${randomUUID()}`
    }).execute();

    await database.insertInto("participants").values({
      id: baselineParticipantId,
      organization_id: organizationId,
      display_name: "Baseline Recipient",
      external_reference: null
    }).execute();

    await database.insertInto("training_participants").values({
      organization_id: organizationId,
      training_id: trainingId,
      participant_id: baselineParticipantId,
      source_import_job_id: null
    }).execute();

    await database.insertInto("certificate_templates").values({
      id: templateId,
      organization_id: organizationId,
      name: "Published Certificate Template"
    }).execute();

    await database.insertInto("template_versions").values({
      id: templateVersionId,
      organization_id: organizationId,
      template_id: templateId,
      version: 1,
      definition_json: { format_version: 1 },
      status: "PUBLISHED",
      published_at: new Date()
    }).execute();
  });

  afterAll(async () => {
    await closeDatabase(database);
  });

  const createEligibleParticipant = async (displayName = "Original Recipient"): Promise<string> => {
    const participantId = randomUUID();
    await database.insertInto("participants").values({
      id: participantId,
      organization_id: organizationId,
      display_name: displayName,
      external_reference: null
    }).execute();
    await database.insertInto("training_participants").values({
      organization_id: organizationId,
      training_id: trainingId,
      participant_id: participantId,
      source_import_job_id: null
    }).execute();
    return participantId;
  };

  const createDraftCertificate = async (input: {
    readonly withSnapshot?: boolean;
    readonly participantId?: string;
  } = {}): Promise<{ certificateId: string; participantId: string }> => {
    const participantId = input.participantId ?? await createEligibleParticipant();
    const certificateId = randomUUID();
    await database.insertInto("certificates").values({
      id: certificateId,
      organization_id: organizationId,
      training_id: trainingId,
      participant_id: participantId,
      template_version_id: templateVersionId,
      certificate_number: `CERT-${randomUUID()}`,
      verification_key_kid: "test-verification-key"
    }).execute();

    if (input.withSnapshot !== false) {
      await database.insertInto("certificate_issuance_snapshots").values({
        certificate_id: certificateId,
        organization_id: organizationId,
        recipient_display_name: "Original Recipient",
        project_name: "Original Project",
        training_name: "Original Training",
        training_code: "ORIGINAL-TRAINING",
        issued_at: plannedIssuedAt
      }).execute();
    }

    return { certificateId, participantId };
  };

  const createGenerationJob = async (revision: number): Promise<string> => {
    const jobId = randomUUID();
    await database.insertInto("jobs").values({
      id: jobId,
      organization_id: organizationId,
      job_type: "CERTIFICATE_GENERATION",
      idempotency_key: `certificate-generation-${randomUUID()}`,
      requested_by_membership_id: membershipId
    }).execute();

    await database.insertInto("certificate_generation_jobs").values({
      job_id: jobId,
      organization_id: organizationId,
      training_id: trainingId,
      template_version_id: templateVersionId,
      generation_revision: revision,
      selection_mode: "EXPLICIT",
      request_fingerprint: Buffer.alloc(32, Math.max(1, revision % 255)),
      renderer_revision: "pdfkit-qrcode-v1"
    }).execute();

    return jobId;
  };

  const createSucceededItem = async (certificateId: string, revision: number): Promise<string> => {
    const jobId = await createGenerationJob(revision);
    await database.insertInto("certificate_generation_items").values({
      organization_id: organizationId,
      job_id: jobId,
      certificate_id: certificateId,
      generation_revision: revision,
      status: "SUCCEEDED"
    }).execute();
    return jobId;
  };

  const publishInitialRevision = async (certificateId: string): Promise<void> => {
    await database.updateTable("certificates")
      .set({ status: "GENERATING", updated_at: new Date() })
      .where("id", "=", certificateId)
      .execute();

    await createSucceededItem(certificateId, 1);

    await database.updateTable("certificates").set({
      status: "AVAILABLE",
      pdf_storage_key: `certificates/${certificateId}/1.pdf`,
      pdf_content_sha256: Buffer.alloc(32, 1),
      pdf_size_bytes: "128",
      pdf_mime_type: "application/pdf",
      issued_at: plannedIssuedAt,
      updated_at: new Date()
    }).where("id", "=", certificateId).execute();
  };

  it("requires and freezes an issuance snapshot before generation", async () => {
    const { certificateId, participantId } = await createDraftCertificate({ withSnapshot: false });

    await expect(database.updateTable("certificates")
      .set({ status: "GENERATING", updated_at: new Date() })
      .where("id", "=", certificateId)
      .execute()).rejects.toMatchObject({ code: "P0001" });

    await database.insertInto("certificate_issuance_snapshots").values({
      certificate_id: certificateId,
      organization_id: organizationId,
      recipient_display_name: "Original Recipient",
      project_name: "Original Project",
      training_name: "Original Training",
      training_code: "ORIGINAL-TRAINING",
      issued_at: plannedIssuedAt
    }).execute();

    await database.updateTable("participants")
      .set({ display_name: "Changed Recipient", updated_at: new Date() })
      .where("id", "=", participantId)
      .execute();
    await database.updateTable("projects")
      .set({ name: "Changed Project", updated_at: new Date() })
      .where("id", "=", projectId)
      .execute();
    await database.updateTable("trainings")
      .set({ name: "Changed Training", code: `CHANGED-${randomUUID()}`, updated_at: new Date() })
      .where("id", "=", trainingId)
      .execute();

    const snapshot = await database.selectFrom("certificate_issuance_snapshots")
      .select([
        "recipient_display_name",
        "project_name",
        "training_name",
        "training_code",
        "snapshot_schema_version",
        "issued_at"
      ])
      .where("certificate_id", "=", certificateId)
      .executeTakeFirstOrThrow();

    expect(snapshot.recipient_display_name).toBe("Original Recipient");
    expect(snapshot.project_name).toBe("Original Project");
    expect(snapshot.training_name).toBe("Original Training");
    expect(snapshot.training_code).toBe("ORIGINAL-TRAINING");
    expect(snapshot.snapshot_schema_version).toBe(1);
    expect(snapshot.issued_at.toISOString()).toBe(plannedIssuedAt.toISOString());

    await expect(database.updateTable("certificate_issuance_snapshots")
      .set({ recipient_display_name: "Mutated Snapshot" })
      .where("certificate_id", "=", certificateId)
      .execute()).rejects.toMatchObject({ code: "P0001" });

    await expect(database.deleteFrom("certificate_issuance_snapshots")
      .where("certificate_id", "=", certificateId)
      .execute()).rejects.toMatchObject({ code: "P0001" });

    await database.updateTable("certificates")
      .set({ status: "GENERATING", updated_at: new Date() })
      .where("id", "=", certificateId)
      .execute();
  });

  it("requires initial publication to use the planned immutable issuance time", async () => {
    const { certificateId } = await createDraftCertificate();

    await database.updateTable("certificates")
      .set({ status: "GENERATING", updated_at: new Date() })
      .where("id", "=", certificateId)
      .execute();
    await createSucceededItem(certificateId, 1);

    await expect(database.updateTable("certificates").set({
      status: "AVAILABLE",
      pdf_storage_key: `certificates/${certificateId}/wrong-time.pdf`,
      pdf_content_sha256: Buffer.alloc(32, 7),
      pdf_size_bytes: "128",
      pdf_mime_type: "application/pdf",
      issued_at: new Date("2026-08-25T07:00:00.000Z"),
      updated_at: new Date()
    }).where("id", "=", certificateId).execute()).rejects.toMatchObject({ code: "P0001" });

    await database.updateTable("certificates").set({
      status: "AVAILABLE",
      pdf_storage_key: `certificates/${certificateId}/1.pdf`,
      pdf_content_sha256: Buffer.alloc(32, 1),
      pdf_size_bytes: "128",
      pdf_mime_type: "application/pdf",
      issued_at: plannedIssuedAt,
      updated_at: new Date()
    }).where("id", "=", certificateId).execute();
  });

  it("enforces immutable certificate identity and a terminal revocation lifecycle", async () => {
    await expect(database.insertInto("certificates").values({
      organization_id: organizationId,
      training_id: trainingId,
      participant_id: baselineParticipantId,
      template_version_id: templateVersionId,
      certificate_number: `CERT-${randomUUID()}`,
      verification_key_kid: "test-verification-key",
      status: "AVAILABLE",
      pdf_storage_key: "forbidden.pdf",
      pdf_content_sha256: Buffer.alloc(32, 2),
      pdf_size_bytes: "64",
      pdf_mime_type: "application/pdf",
      issued_at: plannedIssuedAt
    }).execute()).rejects.toMatchObject({ code: "P0001" });

    const { certificateId } = await createDraftCertificate();

    await expect(database.updateTable("certificates")
      .set({ certificate_number: `MUTATED-${randomUUID()}`, updated_at: new Date() })
      .where("id", "=", certificateId)
      .execute()).rejects.toMatchObject({ code: "P0001" });

    await publishInitialRevision(certificateId);

    await expect(database.updateTable("certificates")
      .set({ status: "DRAFT", updated_at: new Date() })
      .where("id", "=", certificateId)
      .execute()).rejects.toMatchObject({ code: "P0001" });

    await database.updateTable("certificates").set({
      status: "REVOKED",
      revoked_at: new Date("2026-08-24T08:00:00.000Z"),
      revocation_reason: "Issued in error",
      updated_at: new Date()
    }).where("id", "=", certificateId).execute();

    await expect(database.updateTable("certificates")
      .set({ status: "AVAILABLE", updated_at: new Date() })
      .where("id", "=", certificateId)
      .execute()).rejects.toMatchObject({ code: "P0001" });

    await expect(database.updateTable("certificates")
      .set({ revocation_reason: "Changed reason", updated_at: new Date() })
      .where("id", "=", certificateId)
      .execute()).rejects.toMatchObject({ code: "P0001" });

    await expect(database.deleteFrom("certificates")
      .where("id", "=", certificateId)
      .execute()).rejects.toMatchObject({ code: "P0001" });
  });

  it("rejects stale writers and only publishes the next succeeded generation revision", async () => {
    const { certificateId } = await createDraftCertificate();
    await publishInitialRevision(certificateId);

    await createSucceededItem(certificateId, 2);
    await database.updateTable("certificates").set({
      generation_revision: 2,
      pdf_storage_key: `certificates/${certificateId}/2.pdf`,
      pdf_content_sha256: Buffer.alloc(32, 2),
      pdf_size_bytes: "256",
      pdf_mime_type: "application/pdf",
      updated_at: new Date()
    }).where("id", "=", certificateId).execute();

    await expect(database.updateTable("certificates").set({
      generation_revision: 2,
      pdf_storage_key: `certificates/${certificateId}/stale-2.pdf`,
      pdf_content_sha256: Buffer.alloc(32, 9),
      pdf_size_bytes: "999",
      pdf_mime_type: "application/pdf",
      updated_at: new Date()
    }).where("id", "=", certificateId).execute()).rejects.toMatchObject({ code: "P0001" });

    await expect(database.updateTable("certificates")
      .set({ generation_revision: 1, updated_at: new Date() })
      .where("id", "=", certificateId)
      .execute()).rejects.toMatchObject({ code: "P0001" });

    const aheadJobId = await createGenerationJob(4);
    await expect(database.insertInto("certificate_generation_items").values({
      organization_id: organizationId,
      job_id: aheadJobId,
      certificate_id: certificateId,
      generation_revision: 4,
      status: "SUCCEEDED"
    }).execute()).rejects.toMatchObject({ code: "P0001" });

    await createSucceededItem(certificateId, 3);
    await database.updateTable("certificates").set({
      generation_revision: 3,
      pdf_storage_key: `certificates/${certificateId}/3.pdf`,
      pdf_content_sha256: Buffer.alloc(32, 3),
      pdf_size_bytes: "384",
      pdf_mime_type: "application/pdf",
      updated_at: new Date()
    }).where("id", "=", certificateId).execute();

    const current = await database.selectFrom("certificates")
      .select(["status", "generation_revision", "pdf_storage_key", "issued_at"])
      .where("id", "=", certificateId)
      .executeTakeFirstOrThrow();

    expect(current.status).toBe("AVAILABLE");
    expect(current.generation_revision).toBe(3);
    expect(current.pdf_storage_key).toBe(`certificates/${certificateId}/3.pdf`);
    expect(current.issued_at?.toISOString()).toBe(plannedIssuedAt.toISOString());
  });

  it("makes generation-job request identity and renderer revision immutable", async () => {
    const jobId = await createGenerationJob(1);

    await expect(database.updateTable("certificate_generation_jobs")
      .set({ generation_revision: 2 })
      .where("job_id", "=", jobId)
      .execute()).rejects.toMatchObject({ code: "P0001" });

    await expect(database.updateTable("certificate_generation_jobs")
      .set({ renderer_revision: "pdfkit-qrcode-v2" })
      .where("job_id", "=", jobId)
      .execute()).rejects.toMatchObject({ code: "P0001" });

    await expect(database.updateTable("certificate_generation_jobs")
      .set({ request_fingerprint: Buffer.alloc(32, 8) })
      .where("job_id", "=", jobId)
      .execute()).rejects.toMatchObject({ code: "P0001" });

    await expect(database.deleteFrom("certificate_generation_jobs")
      .where("job_id", "=", jobId)
      .execute()).rejects.toMatchObject({ code: "P0001" });
  });

  it("preserves legacy null kids but requires immutable valid kids for new certificates", async () => {
    const legacy = await createDraftCertificate();
    await database.updateTable("certificates").set({ updated_at: new Date() }).where("id", "=", legacy.certificateId).execute();
    await expect(database.updateTable("certificates").set({ verification_key_kid: "changed", updated_at: new Date() })
      .where("id", "=", legacy.certificateId).execute()).rejects.toMatchObject({ code: "P0001" });
  });

  it("allows at most one non-revoked certificate and requires a new identity after revocation", async () => {
    const participantId = await createEligibleParticipant("Reissue Recipient");
    const first = await createDraftCertificate({ participantId });

    await expect(database.insertInto("certificates").values({
      organization_id: organizationId,
      training_id: trainingId,
      participant_id: participantId,
      template_version_id: templateVersionId,
      certificate_number: `CERT-${randomUUID()}`,
      verification_key_kid: "test-verification-key"
    }).execute()).rejects.toMatchObject({ code: "23505" });

    await publishInitialRevision(first.certificateId);
    await database.updateTable("certificates").set({
      status: "REVOKED",
      revoked_at: new Date("2026-08-24T09:00:00.000Z"),
      revocation_reason: "Reissue approved",
      updated_at: new Date()
    }).where("id", "=", first.certificateId).execute();

    const second = await createDraftCertificate({ participantId });
    expect(second.certificateId).not.toBe(first.certificateId);

    const rows = await database.selectFrom("certificates")
      .select(["id", "status", "public_identifier", "certificate_number"])
      .where("organization_id", "=", organizationId)
      .where("training_id", "=", trainingId)
      .where("participant_id", "=", participantId)
      .orderBy("created_at", "asc")
      .execute();

    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe("REVOKED");
    expect(rows[1]?.status).toBe("DRAFT");
    expect(rows[0]?.public_identifier).not.toBe(rows[1]?.public_identifier);
    expect(rows[0]?.certificate_number).not.toBe(rows[1]?.certificate_number);
  });
});
