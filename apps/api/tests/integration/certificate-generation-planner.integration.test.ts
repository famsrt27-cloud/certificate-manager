import { randomUUID } from "node:crypto";

import { closeDatabase, createDatabase, planCertificateGeneration } from "@certificate-platform/database";
import { createCertificateGenerationRequestFingerprint } from "@certificate-platform/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = databaseUrl !== undefined && new URL(databaseUrl).pathname.toLowerCase().includes("test");
const issuedAt = new Date("2026-08-25T06:00:00.000Z");

describe.skipIf(!enabled)("certificate generation planner PostgreSQL integration", () => {
  const database = createDatabase({ connectionString: databaseUrl!, maxConnections: 8 });
  const organizationId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const projectId = randomUUID();
  const trainingId = randomUUID();
  const templateId = randomUUID();
  const templateVersionId = randomUUID();

  beforeAll(async () => {
    await database.insertInto("organizations").values({ id: organizationId, name: "Planner Tenant" }).execute();
    await database.insertInto("users").values({ id: userId, email: `planner-${randomUUID()}@example.invalid`, password_hash: "synthetic" }).execute();
    await database.insertInto("organization_memberships").values({ id: membershipId, organization_id: organizationId, user_id: userId }).execute();
    await database.insertInto("projects").values({ id: projectId, organization_id: organizationId, name: "Planner Project", slug: `planner-${randomUUID()}` }).execute();
    await database.insertInto("trainings").values({ id: trainingId, organization_id: organizationId, project_id: projectId, name: "Planner Training", code: `PLAN-${randomUUID()}` }).execute();
    await database.insertInto("certificate_templates").values({ id: templateId, organization_id: organizationId, name: "Planner Template" }).execute();
    await database.insertInto("template_versions").values({ id: templateVersionId, organization_id: organizationId, template_id: templateId, version: 1, definition_json: { format_version: 1 }, status: "PUBLISHED", published_at: issuedAt }).execute();
  });
  afterAll(async () => closeDatabase(database));

  const participant = async (name: string) => {
    const id = randomUUID();
    await database.insertInto("participants").values({ id, organization_id: organizationId, display_name: name, external_reference: null }).execute();
    await database.insertInto("training_participants").values({ organization_id: organizationId, training_id: trainingId, participant_id: id, source_import_job_id: null }).execute();
    return id;
  };
  const input = (key: string, mode: "EXPLICIT" | "ALL_ELIGIBLE", ids?: readonly string[]) => ({ organizationId, trainingId,
    templateVersionId, idempotencyKey: key, requestedByMembershipId: membershipId, selectionMode: mode,
    ...(ids === undefined ? {} : { requestedParticipantIds: ids }), rendererRevision: "pdfkit-qrcode-v1",
    verificationKeyKid: "key-2026-01", plannedIssuedAt: issuedAt });

  const historicalCertificate = async (status: "DRAFT" | "GENERATING" | "AVAILABLE" | "REVOKED") => {
    const participantId = await participant(`History ${status}`);
    const certificate = await database.insertInto("certificates").values({ organization_id: organizationId, training_id: trainingId,
      participant_id: participantId, template_version_id: templateVersionId, certificate_number: `HISTORY-${randomUUID()}`,
      verification_key_kid: "key-2026-01" }).returning("id").executeTakeFirstOrThrow();
    if (status !== "DRAFT") {
      await database.insertInto("certificate_issuance_snapshots").values({ certificate_id: certificate.id, organization_id: organizationId,
        recipient_display_name: `History ${status}`, project_name: "Planner Project", training_name: "Planner Training",
        training_code: "PLAN-HISTORY", issued_at: issuedAt }).execute();
      await database.updateTable("certificates").set({ status: "GENERATING", updated_at: issuedAt }).where("id", "=", certificate.id).execute();
    }
    if (status === "AVAILABLE" || status === "REVOKED") {
      const jobId = randomUUID();
      await database.insertInto("jobs").values({ id: jobId, organization_id: organizationId, job_type: "CERTIFICATE_GENERATION",
        idempotency_key: `history-${randomUUID()}`, requested_by_membership_id: membershipId }).execute();
      await database.insertInto("certificate_generation_jobs").values({ job_id: jobId, organization_id: organizationId,
        training_id: trainingId, template_version_id: templateVersionId, selection_mode: "EXPLICIT",
        request_fingerprint: Buffer.alloc(32, 1), renderer_revision: "pdfkit-qrcode-v1" }).execute();
      await database.insertInto("certificate_generation_items").values({ organization_id: organizationId, job_id: jobId,
        certificate_id: certificate.id, generation_revision: 1, status: "SUCCEEDED" }).execute();
      await database.updateTable("certificates").set({ status: "AVAILABLE", issued_at: issuedAt,
        pdf_storage_key: `certificates/${certificate.id}/1.pdf`, pdf_content_sha256: Buffer.alloc(32, 1), pdf_size_bytes: "100",
        pdf_mime_type: "application/pdf", updated_at: issuedAt }).where("id", "=", certificate.id).execute();
    }
    if (status === "REVOKED") await database.updateTable("certificates").set({ status: "REVOKED", revoked_at: issuedAt,
      revocation_reason: "Historical", updated_at: issuedAt }).where("id", "=", certificate.id).execute();
    return { participantId, certificateId: certificate.id };
  };

  it("materializes exact explicit inputs, snapshots, items and durable outbox", async () => {
    const a = await participant("Recipient A"); const b = await participant("Recipient B");
    const result = await planCertificateGeneration(database, input(`explicit-${randomUUID()}`, "EXPLICIT", [b, a]));
    expect(result.kind).toBe("CREATED"); if (result.kind !== "CREATED") return;
    const detail = await database.selectFrom("certificate_generation_jobs").selectAll().where("job_id", "=", result.jobId).executeTakeFirstOrThrow();
    expect(detail.selection_mode).toBe("EXPLICIT"); expect(detail.renderer_revision).toBe("pdfkit-qrcode-v1");
    expect(Buffer.from(detail.request_fingerprint)).toEqual(Buffer.from(createCertificateGenerationRequestFingerprint({ organizationId, trainingId, templateVersionId, selectionMode: "EXPLICIT", resolvedParticipantIds: [a, b] })));
    const certificates = await database.selectFrom("certificates").selectAll().where("organization_id", "=", organizationId).where("participant_id", "in", [a, b]).execute();
    expect(certificates).toHaveLength(2); expect(certificates.every((row) => row.verification_key_kid === "key-2026-01" && /^[a-f0-9]{32}$/.test(row.public_identifier))).toBe(true);
    const snapshots = await database.selectFrom("certificate_issuance_snapshots").selectAll().where("certificate_id", "in", certificates.map((row) => row.id)).execute();
    expect(snapshots.map((row) => row.recipient_display_name).sort()).toEqual(["Recipient A", "Recipient B"]);
    expect(snapshots.every((row) => row.issued_at.toISOString() === issuedAt.toISOString() && row.project_name === "Planner Project")).toBe(true);
    expect(await database.selectFrom("certificate_generation_items").select("id").where("job_id", "=", result.jobId).execute()).toHaveLength(2);
    expect(await database.selectFrom("queue_outbox").select("id").where("deduplication_key", "=", `${result.jobId}-generate`).execute()).toHaveLength(1);
  });

  it("replays explicit canonical semantics and rejects changed semantics", async () => {
    const a = await participant("Replay A"); const b = await participant("Replay B"); const c = await participant("Replay C"); const key = `replay-${randomUUID()}`;
    const first = await planCertificateGeneration(database, input(key, "EXPLICIT", [a, b]));
    const replay = await planCertificateGeneration(database, input(key, "EXPLICIT", [b, a]));
    expect(first.kind).toBe("CREATED"); expect(replay.kind).toBe("EXISTING");
    expect(await planCertificateGeneration(database, input(key, "EXPLICIT", [a, c]))).toMatchObject({ kind: "IDEMPOTENCY_CONFLICT" });
    expect(await planCertificateGeneration(database, input(key, "ALL_ELIGIBLE"))).toMatchObject({ kind: "IDEMPOTENCY_CONFLICT" });
  });

  it("excludes every certificate history state and keeps explicit planning all-or-conflict", async () => {
    const histories = await Promise.all((["DRAFT", "GENERATING", "AVAILABLE", "REVOKED"] as const).map(historicalCertificate));
    const eligible = await participant("Still Eligible"); const key = `history-exclusion-${randomUUID()}`;
    const result = await planCertificateGeneration(database, input(key, "EXPLICIT", [eligible, ...histories.map((row) => row.participantId)]));
    expect(result.kind).toBe("INELIGIBLE");
    expect(await database.selectFrom("jobs").select("id").where("organization_id", "=", organizationId).where("idempotency_key", "=", key).execute()).toHaveLength(0);
    expect(await database.selectFrom("certificates").select("id").where("organization_id", "=", organizationId).where("participant_id", "=", eligible).execute()).toHaveLength(0);
  });

  it("rolls back every intermediate planning write on a database failure", async () => {
    const eligible = await participant("Rollback Recipient"); const key = `rollback-${randomUUID()}`;
    await expect(planCertificateGeneration(database, { ...input(key, "EXPLICIT", [eligible]), verificationKeyKid: "invalid kid" })).rejects.toMatchObject({ code: "23514" });
    expect(await database.selectFrom("jobs").select("id").where("organization_id", "=", organizationId).where("idempotency_key", "=", key).execute()).toHaveLength(0);
    expect(await database.selectFrom("certificates").select("id").where("organization_id", "=", organizationId).where("participant_id", "=", eligible).execute()).toHaveLength(0);
  });

  it("keeps renderer, key and issuance snapshot planning inputs immutable", async () => {
    const eligible = await participant("Immutable Recipient"); const result = await planCertificateGeneration(database, input(`immutable-${randomUUID()}`, "EXPLICIT", [eligible]));
    expect(result.kind).toBe("CREATED"); if (result.kind !== "CREATED") return;
    const certificate = await database.selectFrom("certificates").select("id").where("participant_id", "=", eligible).executeTakeFirstOrThrow();
    await expect(database.updateTable("certificate_generation_jobs").set({ renderer_revision: "pdfkit-qrcode-v2" }).where("job_id", "=", result.jobId).execute()).rejects.toMatchObject({ code: "P0001" });
    await expect(database.updateTable("certificates").set({ verification_key_kid: "key-2026-02" }).where("id", "=", certificate.id).execute()).rejects.toMatchObject({ code: "P0001" });
    await expect(database.updateTable("certificate_issuance_snapshots").set({ issued_at: new Date("2026-08-26T00:00:00Z") }).where("certificate_id", "=", certificate.id).execute()).rejects.toMatchObject({ code: "P0001" });
  });

  it("keeps ALL_ELIGIBLE replay population stable", async () => {
    const a = await participant("All A"); const b = await participant("All B"); const key = `all-${randomUUID()}`;
    const first = await planCertificateGeneration(database, input(key, "ALL_ELIGIBLE")); expect(first.kind).toBe("CREATED");
    const c = await participant("All C"); const replay = await planCertificateGeneration(database, input(key, "ALL_ELIGIBLE")); expect(replay.kind).toBe("EXISTING");
    expect(await database.selectFrom("certificates").select("id").where("organization_id", "=", organizationId).where("training_id", "=", trainingId).where("participant_id", "=", c).execute()).toHaveLength(0);
    expect(a).not.toBe(b);
  });

  it("returns no-work without durable effects for an empty active training", async () => {
    const emptyTrainingId = randomUUID(); const key = `no-work-${randomUUID()}`;
    await database.insertInto("trainings").values({ id: emptyTrainingId, organization_id: organizationId, project_id: projectId,
      name: "Empty Training", code: `EMPTY-${randomUUID()}` }).execute();
    const result = await planCertificateGeneration(database, { ...input(key, "ALL_ELIGIBLE"), trainingId: emptyTrainingId });
    expect(result.kind).toBe("NO_WORK");
    expect(await database.selectFrom("jobs").select("id").where("organization_id", "=", organizationId).where("idempotency_key", "=", key).execute()).toHaveLength(0);
    expect(await database.selectFrom("queue_outbox").select("id").where("organization_id", "=", organizationId).where("deduplication_key", "like", `%${key}%`).execute()).toHaveLength(0);
  });

  it("is race safe for same and different idempotency keys", async () => {
    const same = await participant("Concurrent Same"); const key = `same-${randomUUID()}`;
    const sameResults = await Promise.all([planCertificateGeneration(database, input(key, "EXPLICIT", [same])), planCertificateGeneration(database, input(key, "EXPLICIT", [same]))]);
    expect(sameResults.map((row) => row.kind).sort()).toEqual(["CREATED", "EXISTING"]);
    const different = await participant("Concurrent Different");
    const differentResults = await Promise.all([planCertificateGeneration(database, input(`d1-${randomUUID()}`, "EXPLICIT", [different])), planCertificateGeneration(database, input(`d2-${randomUUID()}`, "EXPLICIT", [different]))]);
    expect(differentResults.filter((row) => row.kind === "CREATED")).toHaveLength(1);
    expect(await database.selectFrom("certificates").select("id").where("organization_id", "=", organizationId).where("training_id", "=", trainingId).where("participant_id", "=", different).execute()).toHaveLength(1);
  });
});
