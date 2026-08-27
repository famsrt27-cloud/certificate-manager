import { createHash, randomUUID } from "node:crypto";

import {
  cleanupExpiredParticipantImports, closeDatabase, confirmParticipantImport, createDatabase, createParticipantImport,
  inspectParticipantImport
} from "@certificate-platform/database";
import type { PrivateObjectStorage } from "@certificate-platform/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ParticipantImportSourceCleanupReconciler } from "../../src/participant-import-source-cleanup-reconciler.js";
import { ParticipantImportProcessor } from "../../src/processors/participant-import-processor.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationEnabled = databaseUrl !== undefined && new URL(databaseUrl).pathname.toLowerCase().includes("test");

describe.skipIf(!integrationEnabled)("participant import worker PostgreSQL integration", () => {
  const database = createDatabase({ connectionString: databaseUrl!, maxConnections: 2 });
  const organizationId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const projectId = randomUUID();
  const trainingId = randomUUID();
  const jobId = randomUUID();
  const storageKey = `participant-imports/${organizationId}/${jobId}/synthetic.csv`;
  const bytes = Buffer.from("display_name,external_reference\nSynthetic Person,REF-1\n,REF-2\n");
  const objects = new Map<string, Uint8Array>();
  let failStorageDeletes = false;
  objects.set(storageKey, new Uint8Array(bytes));
  const storage: PrivateObjectStorage = {
    put: async (input) => { objects.set(input.key, input.body); },
    get: async (key) => {
      const value = objects.get(key);
      if (value === undefined) throw new Error("missing synthetic object");
      return value;
    },
    delete: async (key) => {
      if (failStorageDeletes) throw new Error("synthetic storage delete failure");
      objects.delete(key);
    }
  };
  const processor = new ParticipantImportProcessor({ database, storage, maximumBytes: 1_024 * 1_024,
    maximumRows: 100, maximumUncompressedBytes: 2 * 1_024 * 1_024 });
  const sourceCleanup = new ParticipantImportSourceCleanupReconciler({
    database,
    storage,
    batchSize: 20,
    retryDelayMs: 0,
    organizationId
  });

  beforeAll(async () => {
    await database.insertInto("users").values({ id: userId, email: `worker-${randomUUID()}@example.invalid`, password_hash: "synthetic" }).execute();
    await database.insertInto("organizations").values({ id: organizationId, name: "Synthetic Worker Tenant" }).execute();
    await database.insertInto("organization_memberships").values({ id: membershipId, organization_id: organizationId, user_id: userId }).execute();
    await database.insertInto("projects").values({ id: projectId, organization_id: organizationId, name: "Synthetic Project",
      slug: `synthetic-${randomUUID()}` }).execute();
    await database.insertInto("trainings").values({ id: trainingId, organization_id: organizationId, project_id: projectId,
      name: "Synthetic Training", code: `CODE-${randomUUID()}` }).execute();
    await createParticipantImport(database, { jobId, organizationId, trainingId, idempotencyKey: `worker-${randomUUID()}`,
      requestedByMembershipId: membershipId, sourceStorageKey: storageKey, originalFilename: "synthetic.csv",
      contentSha256: createHash("sha256").update(bytes).digest(), detectedMimeType: "text/csv", sizeBytes: bytes.byteLength });
  });

  afterAll(async () => {
    await database.deleteFrom("queue_outbox").where("organization_id", "=", organizationId).execute();
    await database.deleteFrom("training_participants").where("organization_id", "=", organizationId).execute();
    await database.deleteFrom("participant_import_rows").where("organization_id", "=", organizationId).execute();
    await database.deleteFrom("participants").where("organization_id", "=", organizationId).execute();
    await database.deleteFrom("participant_import_jobs").where("organization_id", "=", organizationId).execute();
    await database.deleteFrom("jobs").where("organization_id", "=", organizationId).execute();
    await database.deleteFrom("trainings").where("organization_id", "=", organizationId).execute();
    await database.deleteFrom("projects").where("organization_id", "=", organizationId).execute();
    await database.deleteFrom("organization_memberships").where("id", "=", membershipId).execute();
    await database.deleteFrom("organizations").where("id", "=", organizationId).execute();
    await database.deleteFrom("users").where("id", "=", userId).execute();
    await closeDatabase(database);
  });

  it("validates, previews, confirms and imports only valid staged rows idempotently", async () => {
    await processor.process({ version: 1, job_id: jobId, organization_id: organizationId, operation: "VALIDATE" });
    expect(objects.has(storageKey)).toBe(true);
    expect(await sourceCleanup.runOnce()).toEqual({ claimed: 1, deleted: 1, failed: 0 });
    expect(objects.has(storageKey)).toBe(false);
    const preview = await inspectParticipantImport(database, organizationId, jobId, 50);
    expect(preview?.job.status).toBe("AWAITING_CONFIRMATION");
    expect(preview?.counts).toEqual({ valid: 1, invalid: 1 });
    expect(await confirmParticipantImport(database, organizationId, jobId)).toBe("CONFIRMED");
    await processor.process({ version: 1, job_id: jobId, organization_id: organizationId, operation: "CONFIRM" });
    await processor.process({ version: 1, job_id: jobId, organization_id: organizationId, operation: "CONFIRM" });
    const job = await database.selectFrom("jobs").select("status").where("id", "=", jobId).executeTakeFirstOrThrow();
    const participants = await database.selectFrom("participants").select(["display_name", "external_reference"])
      .where("organization_id", "=", organizationId).execute();
    const relations = await database.selectFrom("training_participants").select("id")
      .where("organization_id", "=", organizationId).where("training_id", "=", trainingId).execute();
    const stagedRows = await database.selectFrom("participant_import_rows").select("id")
      .where("organization_id", "=", organizationId).where("job_id", "=", jobId).execute();
    expect(job.status).toBe("SUCCEEDED");
    expect(participants).toEqual([{ display_name: "Synthetic Person", external_reference: "REF-1" }]);
    expect(relations).toHaveLength(1);
    expect(stagedRows).toHaveLength(0);
  });

  it("cancels expired previews and removes their staged rows", async () => {
    const expiredJobId = randomUUID();
    const expiredStorageKey = `participant-imports/${organizationId}/${expiredJobId}/expired.csv`;
    await createParticipantImport(database, {
      jobId: expiredJobId, organizationId, trainingId, idempotencyKey: `expired-${randomUUID()}`,
      requestedByMembershipId: membershipId, sourceStorageKey: expiredStorageKey, originalFilename: "expired.csv",
      contentSha256: createHash("sha256").update("expired").digest(), detectedMimeType: "text/csv", sizeBytes: 7
    });
    await database.updateTable("jobs").set({ status: "AWAITING_CONFIRMATION", created_at: new Date("2020-01-01T00:00:00Z") })
      .where("id", "=", expiredJobId).execute();
    await database.insertInto("participant_import_rows").values({
      id: randomUUID(), organization_id: organizationId, job_id: expiredJobId, row_number: 2,
      display_name: "Temporary Person", external_reference: null,
      status: "VALID", validation_errors: null, participant_id: null
    }).execute();

    const cleaned = await cleanupExpiredParticipantImports(database, new Date("2020-01-08T00:00:00Z"));
    const repeated = await cleanupExpiredParticipantImports(database, new Date("2020-01-08T00:00:00Z"));
    const expiredJob = await database.selectFrom("jobs").select(["status", "last_error_code"])
      .where("id", "=", expiredJobId).executeTakeFirstOrThrow();
    const detail = await database.selectFrom("participant_import_jobs")
      .select(["source_cleanup_requested_at", "retention_cleanup_completed_at"])
      .where("job_id", "=", expiredJobId)
      .executeTakeFirstOrThrow();
    const stagedRows = await database.selectFrom("participant_import_rows").select("id")
      .where("job_id", "=", expiredJobId).execute();

    expect(cleaned).toBe(1);
    expect(repeated).toBe(0);
    expect(expiredJob).toEqual({ status: "CANCELLED", last_error_code: "IMPORT_CONFIRMATION_EXPIRED" });
    expect(detail.source_cleanup_requested_at).toBeInstanceOf(Date);
    expect(detail.retention_cleanup_completed_at).toBeInstanceOf(Date);
    expect(stagedRows).toHaveLength(0);

    expect(await sourceCleanup.runOnce()).toEqual({ claimed: 1, deleted: 1, failed: 0 });
    expect(await sourceCleanup.runOnce()).toEqual({ claimed: 0, deleted: 0, failed: 0 });
  });

  it("keeps a validated import successful when source deletion fails and retries cleanup independently", async () => {
    const cleanupJobId = randomUUID();
    const cleanupStorageKey = `participant-imports/${organizationId}/${cleanupJobId}/cleanup.csv`;
    const cleanupBytes = Buffer.from("display_name,external_reference\nCleanup Person,CLEAN-1\n");
    objects.set(cleanupStorageKey, new Uint8Array(cleanupBytes));
    await createParticipantImport(database, {
      jobId: cleanupJobId,
      organizationId,
      trainingId,
      idempotencyKey: `cleanup-${randomUUID()}`,
      requestedByMembershipId: membershipId,
      sourceStorageKey: cleanupStorageKey,
      originalFilename: "cleanup.csv",
      contentSha256: createHash("sha256").update(cleanupBytes).digest(),
      detectedMimeType: "text/csv",
      sizeBytes: cleanupBytes.byteLength
    });

    await processor.process({
      version: 1,
      job_id: cleanupJobId,
      organization_id: organizationId,
      operation: "VALIDATE"
    });

    failStorageDeletes = true;
    const failedCleanup = await sourceCleanup.runOnce();
    failStorageDeletes = false;

    const jobAfterDeleteFailure = await database.selectFrom("jobs")
      .select(["status", "last_error_code"])
      .where("id", "=", cleanupJobId)
      .executeTakeFirstOrThrow();
    const failedMetadata = await database.selectFrom("participant_import_jobs")
      .select([
        "source_cleanup_completed_at",
        "source_cleanup_attempt_count",
        "source_cleanup_last_error_code"
      ])
      .where("job_id", "=", cleanupJobId)
      .executeTakeFirstOrThrow();

    expect(failedCleanup).toEqual({ claimed: 1, deleted: 0, failed: 1 });
    expect(jobAfterDeleteFailure).toEqual({ status: "AWAITING_CONFIRMATION", last_error_code: null });
    expect(failedMetadata.source_cleanup_completed_at).toBeNull();
    expect(failedMetadata.source_cleanup_attempt_count).toBe(1);
    expect(failedMetadata.source_cleanup_last_error_code).toBe("IMPORT_SOURCE_DELETE_FAILED");
    expect(objects.has(cleanupStorageKey)).toBe(true);

    expect(await sourceCleanup.runOnce()).toEqual({ claimed: 1, deleted: 1, failed: 0 });
    expect(await sourceCleanup.runOnce()).toEqual({ claimed: 0, deleted: 0, failed: 0 });
    expect(objects.has(cleanupStorageKey)).toBe(false);

    const completedMetadata = await database.selectFrom("participant_import_jobs")
      .select(["source_cleanup_completed_at", "source_cleanup_attempt_count", "source_cleanup_last_error_code"])
      .where("job_id", "=", cleanupJobId)
      .executeTakeFirstOrThrow();
    expect(completedMetadata.source_cleanup_completed_at).toBeInstanceOf(Date);
    expect(completedMetadata.source_cleanup_attempt_count).toBe(2);
    expect(completedMetadata.source_cleanup_last_error_code).toBeNull();
  });

  it("terminally rejects malicious source content without staging or partial participants and schedules source cleanup", async () => {
    const maliciousJobId = randomUUID();
    const maliciousStorageKey = `participant-imports/${organizationId}/${maliciousJobId}/malicious.csv`;
    const maliciousBytes = Buffer.from("display_name\n\"unclosed");
    objects.set(maliciousStorageKey, new Uint8Array(maliciousBytes));
    await createParticipantImport(database, {
      jobId: maliciousJobId, organizationId, trainingId, idempotencyKey: `malicious-${randomUUID()}`,
      requestedByMembershipId: membershipId, sourceStorageKey: maliciousStorageKey, originalFilename: "malicious.csv",
      contentSha256: createHash("sha256").update(maliciousBytes).digest(), detectedMimeType: "text/csv",
      sizeBytes: maliciousBytes.byteLength
    });

    const participantsBefore = await database.selectFrom("participants").select(({ fn }) => fn.countAll<number>().as("count"))
      .where("organization_id", "=", organizationId).executeTakeFirstOrThrow();
    await processor.process({ version: 1, job_id: maliciousJobId, organization_id: organizationId, operation: "VALIDATE" });
    const job = await database.selectFrom("jobs").select(["status", "last_error_code"])
      .where("id", "=", maliciousJobId).executeTakeFirstOrThrow();
    const detail = await database.selectFrom("participant_import_jobs").select("source_cleanup_requested_at")
      .where("job_id", "=", maliciousJobId).executeTakeFirstOrThrow();
    const staged = await database.selectFrom("participant_import_rows").select("id")
      .where("job_id", "=", maliciousJobId).execute();
    const participantsAfter = await database.selectFrom("participants").select(({ fn }) => fn.countAll<number>().as("count"))
      .where("organization_id", "=", organizationId).executeTakeFirstOrThrow();

    expect(job).toEqual({ status: "FAILED", last_error_code: "IMPORT_FILE_INVALID" });
    expect(detail.source_cleanup_requested_at).toBeInstanceOf(Date);
    expect(staged).toHaveLength(0);
    expect(participantsAfter.count).toBe(participantsBefore.count);
    expect(await sourceCleanup.runOnce()).toEqual({ claimed: 1, deleted: 1, failed: 0 });
    expect(objects.has(maliciousStorageKey)).toBe(false);
  });

  it("does not resolve an import job through a different tenant scope", async () => {
    await expect(processor.process({ version: 1, job_id: jobId, organization_id: randomUUID(), operation: "CONFIRM" }))
      .rejects.toThrow("not found");
  });
});
