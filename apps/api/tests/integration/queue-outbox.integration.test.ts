import { randomUUID } from "node:crypto";

import {
  closeDatabase,
  confirmParticipantImport,
  createDatabase,
  createParticipantImport,
  revertParticipantImportConfirmation
} from "@certificate-platform/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationEnabled = databaseUrl !== undefined
  && new URL(databaseUrl).pathname.toLowerCase().includes("test");

describe.skipIf(!integrationEnabled)("queue outbox PostgreSQL integration", () => {
  const database = createDatabase({ connectionString: databaseUrl!, maxConnections: 2 });
  const organizationId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const projectId = randomUUID();
  const trainingId = randomUUID();

  beforeAll(async () => {
    await database.insertInto("users").values({
      id: userId,
      email: `outbox-${randomUUID()}@example.invalid`,
      password_hash: "synthetic"
    }).execute();
    await database.insertInto("organizations").values({
      id: organizationId,
      name: "Synthetic Outbox Tenant"
    }).execute();
    await database.insertInto("organization_memberships").values({
      id: membershipId,
      organization_id: organizationId,
      user_id: userId
    }).execute();
    await database.insertInto("projects").values({
      id: projectId,
      organization_id: organizationId,
      name: "Synthetic Outbox Project",
      slug: `outbox-${randomUUID()}`
    }).execute();
    await database.insertInto("trainings").values({
      id: trainingId,
      organization_id: organizationId,
      project_id: projectId,
      name: "Synthetic Outbox Training",
      code: `OUTBOX-${randomUUID()}`
    }).execute();
  });

  afterAll(async () => {
    await closeDatabase(database);
  });

  const createImport = async (jobId: string) => createParticipantImport(database, {
    jobId,
    organizationId,
    trainingId,
    idempotencyKey: `outbox-${jobId}`,
    requestedByMembershipId: membershipId,
    sourceStorageKey: `participant-imports/${organizationId}/${jobId}/source.csv`,
    originalFilename: "source.csv",
    contentSha256: new Uint8Array(32).fill(7),
    detectedMimeType: "text/csv",
    sizeBytes: 64
  });

  it("commits the VALIDATE queue intent with the participant import job", async () => {
    const jobId = randomUUID();
    expect(await createImport(jobId)).toBe(true);

    const outbox = await database.selectFrom("queue_outbox")
      .select([
        "organization_id",
        "message_type",
        "deduplication_key",
        "payload_json",
        "dispatched_at",
        "attempt_count"
      ])
      .where("organization_id", "=", organizationId)
      .where("message_type", "=", "PARTICIPANT_IMPORT_VALIDATE")
      .where("deduplication_key", "=", `${jobId}-validate`)
      .executeTakeFirstOrThrow();

    expect(outbox.dispatched_at).toBeNull();
    expect(outbox.attempt_count).toBe(0);
    expect(outbox.payload_json).toEqual({
      version: 1,
      job_id: jobId,
      organization_id: organizationId,
      operation: "VALIDATE"
    });
  });

  it("commits and reverts the CONFIRM queue intent with the confirmation transition", async () => {
    const jobId = randomUUID();
    expect(await createImport(jobId)).toBe(true);

    await database.updateTable("jobs").set({ status: "AWAITING_CONFIRMATION" })
      .where("organization_id", "=", organizationId)
      .where("id", "=", jobId)
      .execute();
    await database.insertInto("participant_import_rows").values({
      organization_id: organizationId,
      job_id: jobId,
      row_number: 1,
      display_name: "Synthetic Person",
      external_reference: "OUTBOX-REF-1",
      status: "VALID",
      validation_errors: null,
      participant_id: null
    }).execute();

    expect(await confirmParticipantImport(database, organizationId, jobId)).toBe("CONFIRMED");
    expect(await confirmParticipantImport(database, organizationId, jobId)).toBe("ALREADY_CONFIRMED");

    const confirmRows = await database.selectFrom("queue_outbox")
      .select(["message_type", "deduplication_key", "payload_json"])
      .where("organization_id", "=", organizationId)
      .where("message_type", "=", "PARTICIPANT_IMPORT_CONFIRM")
      .where("deduplication_key", "=", `${jobId}-confirm`)
      .execute();

    expect(confirmRows).toHaveLength(1);
    expect(confirmRows[0]?.payload_json).toEqual({
      version: 1,
      job_id: jobId,
      organization_id: organizationId,
      operation: "CONFIRM"
    });

    await revertParticipantImportConfirmation(database, organizationId, jobId);

    const pendingConfirm = await database.selectFrom("queue_outbox")
      .select("id")
      .where("organization_id", "=", organizationId)
      .where("message_type", "=", "PARTICIPANT_IMPORT_CONFIRM")
      .where("deduplication_key", "=", `${jobId}-confirm`)
      .where("dispatched_at", "is", null)
      .execute();
    expect(pendingConfirm).toHaveLength(0);

    const revertedState = await database.selectFrom("participant_import_jobs as detail")
      .innerJoin("jobs as job", (join) => join
        .onRef("job.id", "=", "detail.job_id")
        .onRef("job.organization_id", "=", "detail.organization_id"))
      .select(["job.status", "detail.confirmed_at"])
      .where("detail.organization_id", "=", organizationId)
      .where("detail.job_id", "=", jobId)
      .executeTakeFirstOrThrow();

    expect(revertedState.status).toBe("AWAITING_CONFIRMATION");
    expect(revertedState.confirmed_at).toBeNull();
  });
});
