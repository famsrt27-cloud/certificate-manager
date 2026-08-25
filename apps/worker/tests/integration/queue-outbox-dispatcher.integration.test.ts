import { randomUUID } from "node:crypto";

import {
  closeDatabase,
  createDatabase,
  createParticipantImport
} from "@certificate-platform/database";
import type {
  CertificateGenerationJobPayload,
  CertificateGenerationProducer,
  ParticipantImportJobPayload,
  ParticipantImportProducer
} from "@certificate-platform/queue";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { QueueOutboxDispatcher } from "../../src/queue-outbox-dispatcher.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationEnabled = databaseUrl !== undefined
  && new URL(databaseUrl).pathname.toLowerCase().includes("test");

describe.skipIf(!integrationEnabled)("queue outbox dispatcher PostgreSQL integration", () => {
  const database = createDatabase({ connectionString: databaseUrl!, maxConnections: 4 });
  const organizationId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const projectId = randomUUID();
  const trainingId = randomUUID();

  beforeAll(async () => {
    await database.insertInto("users").values({
      id: userId,
      email: `dispatcher-${randomUUID()}@example.invalid`,
      password_hash: "synthetic"
    }).execute();
    await database.insertInto("organizations").values({
      id: organizationId,
      name: "Synthetic Dispatcher Tenant"
    }).execute();
    await database.insertInto("organization_memberships").values({
      id: membershipId,
      organization_id: organizationId,
      user_id: userId
    }).execute();
    await database.insertInto("projects").values({
      id: projectId,
      organization_id: organizationId,
      name: "Synthetic Dispatcher Project",
      slug: `dispatcher-${randomUUID()}`
    }).execute();
    await database.insertInto("trainings").values({
      id: trainingId,
      organization_id: organizationId,
      project_id: projectId,
      name: "Synthetic Dispatcher Training",
      code: `DISPATCH-${randomUUID()}`
    }).execute();
  });

  afterAll(async () => {
    await database.deleteFrom("queue_outbox").where("organization_id", "=", organizationId).execute();
    await database.deleteFrom("participant_import_rows").where("organization_id", "=", organizationId).execute();
    await database.deleteFrom("participant_import_jobs").where("organization_id", "=", organizationId).execute();
    await database.deleteFrom("jobs").where("organization_id", "=", organizationId).execute();
    await database.deleteFrom("trainings").where("organization_id", "=", organizationId).execute();
    await database.deleteFrom("projects").where("organization_id", "=", organizationId).execute();
    await database.deleteFrom("organization_memberships").where("id", "=", membershipId).execute();
    await database.deleteFrom("organizations").where("id", "=", organizationId).execute();
    await database.deleteFrom("users").where("id", "=", userId).execute();
    await closeDatabase(database);
  });

  const createImport = async (jobId: string) => createParticipantImport(database, {
    jobId,
    organizationId,
    trainingId,
    idempotencyKey: `dispatcher-${jobId}`,
    requestedByMembershipId: membershipId,
    sourceStorageKey: `participant-imports/${organizationId}/${jobId}/source.csv`,
    originalFilename: "source.csv",
    contentSha256: new Uint8Array(32).fill(9),
    detectedMimeType: "text/csv",
    sizeBytes: 128
  });

  const producer = (
    deliveries: ParticipantImportJobPayload[],
    shouldFail: () => boolean = () => false
  ): ParticipantImportProducer => ({
    enqueue: async (payload) => {
      if (shouldFail()) throw new Error("synthetic queue unavailable");
      deliveries.push(payload);
    },
    close: async () => undefined
  });

  const generationProducer = (
    deliveries: CertificateGenerationJobPayload[] = [],
    shouldFail: () => boolean = () => false
  ): CertificateGenerationProducer => ({
    enqueue: async (payload) => {
      if (shouldFail()) throw new Error("synthetic queue unavailable");
      deliveries.push(payload);
    },
    close: async () => undefined
  });

  it("keeps a failed dispatch durable and recovers it on a later dispatcher run", async () => {
    const jobId = randomUUID();
    expect(await createImport(jobId)).toBe(true);
    const deliveries: ParticipantImportJobPayload[] = [];
    let queueUnavailable = true;

    const first = new QueueOutboxDispatcher({
      database,
      participantImports: producer(deliveries, () => queueUnavailable),
      certificateGenerations: generationProducer(),
      retryDelayMs: 0,
      reconcileAfterMs: 60_000
    });
    const failedDispatch = await first.dispatchOnce();
    expect(failedDispatch.claimed).toBeGreaterThanOrEqual(1);
    expect(failedDispatch.failed).toBeGreaterThanOrEqual(1);

    const failed = await database.selectFrom("queue_outbox")
      .select(["dispatched_at", "attempt_count", "last_error_code"])
      .where("organization_id", "=", organizationId)
      .where("deduplication_key", "=", `${jobId}-validate`)
      .executeTakeFirstOrThrow();
    expect(failed.dispatched_at).toBeNull();
    expect(failed.attempt_count).toBe(1);
    expect(failed.last_error_code).toBe("QUEUE_DISPATCH_FAILED");

    queueUnavailable = false;
    const restarted = new QueueOutboxDispatcher({
      database,
      participantImports: producer(deliveries, () => queueUnavailable),
      certificateGenerations: generationProducer(),
      retryDelayMs: 0,
      reconcileAfterMs: 60_000
    });
    const recoveredDispatch = await restarted.dispatchOnce();
    expect(recoveredDispatch.claimed).toBeGreaterThanOrEqual(1);
    expect(recoveredDispatch.dispatched).toBe(recoveredDispatch.claimed);
    expect(recoveredDispatch.failed).toBe(0);

    const recovered = await database.selectFrom("queue_outbox")
      .select(["dispatched_at", "attempt_count", "last_error_code"])
      .where("organization_id", "=", organizationId)
      .where("deduplication_key", "=", `${jobId}-validate`)
      .executeTakeFirstOrThrow();
    expect(recovered.dispatched_at).not.toBeNull();
    expect(recovered.attempt_count).toBe(2);
    expect(recovered.last_error_code).toBeNull();
    expect(deliveries.filter((payload) => payload.job_id === jobId)).toEqual([{
      version: 1,
      job_id: jobId,
      organization_id: organizationId,
      operation: "VALIDATE"
    }]);
  });

  it("claims a pending outbox record only once across concurrent dispatchers", async () => {
    const jobId = randomUUID();
    expect(await createImport(jobId)).toBe(true);
    const deliveries: ParticipantImportJobPayload[] = [];
    const sharedProducer = producer(deliveries);

    const left = new QueueOutboxDispatcher({
      database,
      participantImports: sharedProducer,
      retryDelayMs: 60_000,
      reconcileAfterMs: 60_000
    });
    const right = new QueueOutboxDispatcher({
      database,
      participantImports: sharedProducer,
      retryDelayMs: 60_000,
      reconcileAfterMs: 60_000
    });

    await Promise.all([left.dispatchOnce(), right.dispatchOnce()]);
    expect(deliveries.filter((payload) => payload.job_id === jobId)).toHaveLength(1);

    const row = await database.selectFrom("queue_outbox")
      .select(["attempt_count", "dispatched_at"])
      .where("organization_id", "=", organizationId)
      .where("deduplication_key", "=", `${jobId}-validate`)
      .executeTakeFirstOrThrow();
    expect(row.attempt_count).toBe(1);
    expect(row.dispatched_at).not.toBeNull();
  });

  it("keeps certificate generation dispatch retryable until queue recovery", async () => {
    const jobId = randomUUID();
    await database.insertInto("jobs").values({ id: jobId, organization_id: organizationId, job_type: "CERTIFICATE_GENERATION", idempotency_key: `generation-${jobId}`, requested_by_membership_id: membershipId }).execute();
    await database.insertInto("queue_outbox").values({ organization_id: organizationId, message_type: "CERTIFICATE_GENERATION", deduplication_key: `${jobId}-generate`, payload_json: { version: 1, job_id: jobId, organization_id: organizationId } }).execute();
    const deliveries: CertificateGenerationJobPayload[] = [];
    let unavailable = true;
    const generation = generationProducer(deliveries, () => unavailable);
    const imports = producer([]);
    expect((await new QueueOutboxDispatcher({ database, participantImports: imports, certificateGenerations: generation, retryDelayMs: 0, reconcileAfterMs: 60_000 }).dispatchOnce()).failed).toBeGreaterThan(0);
    expect((await database.selectFrom("queue_outbox").select("dispatched_at").where("deduplication_key", "=", `${jobId}-generate`).executeTakeFirstOrThrow()).dispatched_at).toBeNull();
    unavailable = false;
    await new QueueOutboxDispatcher({ database, participantImports: imports, certificateGenerations: generation, retryDelayMs: 0, reconcileAfterMs: 60_000 }).dispatchOnce();
    expect(deliveries.filter((payload) => payload.job_id === jobId)).toEqual([{ version: 1, job_id: jobId, organization_id: organizationId }]);
    expect((await database.selectFrom("queue_outbox").select("dispatched_at").where("deduplication_key", "=", `${jobId}-generate`).executeTakeFirstOrThrow()).dispatched_at).not.toBeNull();
  });

  it("rejects malformed certificate generation payloads without false delivery", async () => {
    const jobId = randomUUID();
    await database.insertInto("jobs").values({ id: jobId, organization_id: organizationId, job_type: "CERTIFICATE_GENERATION", idempotency_key: `malformed-${jobId}`, requested_by_membership_id: membershipId }).execute();
    await database.insertInto("queue_outbox").values({
      organization_id: organizationId,
      message_type: "CERTIFICATE_GENERATION",
      deduplication_key: `${jobId}-generate`,
      payload_json: { version: 1, job_id: jobId, organization_id: organizationId, token: "must-not-dispatch" },
      created_at: new Date("1800-01-01T00:00:00.000Z")
    }).execute();
    const deliveries: CertificateGenerationJobPayload[] = [];
    const result = await new QueueOutboxDispatcher({
      database,
      participantImports: producer([]),
      certificateGenerations: generationProducer(deliveries),
      batchSize: 1,
      retryDelayMs: 0,
      reconcileAfterMs: 60_000
    }).dispatchOnce();
    expect(result).toEqual({ claimed: 1, dispatched: 0, failed: 1 });
    expect(deliveries).toHaveLength(0);
    expect(await database.selectFrom("queue_outbox").select(["dispatched_at", "last_error_code"])
      .where("deduplication_key", "=", `${jobId}-generate`).executeTakeFirstOrThrow())
      .toEqual({ dispatched_at: null, last_error_code: "OUTBOX_PAYLOAD_INVALID" });
  });

  it("re-arms a dispatched message when PostgreSQL still shows an unstarted queued job", async () => {
    const jobId = randomUUID();
    expect(await createImport(jobId)).toBe(true);
    const deliveries: ParticipantImportJobPayload[] = [];
    const sharedProducer = producer(deliveries);
    const first = new QueueOutboxDispatcher({
      database,
      participantImports: sharedProducer,
      retryDelayMs: 0,
      reconcileAfterMs: 60_000
    });
    await first.dispatchOnce();

    const stale = new Date("2020-01-01T00:00:00.000Z");
    await database.updateTable("jobs").set({
      queued_at: stale,
      started_at: null
    }).where("organization_id", "=", organizationId).where("id", "=", jobId).execute();
    await database.updateTable("queue_outbox").set({
      dispatched_at: stale,
      last_attempt_at: stale
    }).where("organization_id", "=", organizationId)
      .where("deduplication_key", "=", `${jobId}-validate`).execute();

    const recovery = new QueueOutboxDispatcher({
      database,
      participantImports: sharedProducer,
      retryDelayMs: 0,
      reconcileAfterMs: 1_000
    });
    await recovery.dispatchOnce();

    const row = await database.selectFrom("queue_outbox")
      .select(["attempt_count", "dispatched_at"])
      .where("organization_id", "=", organizationId)
      .where("deduplication_key", "=", `${jobId}-validate`)
      .executeTakeFirstOrThrow();
    expect(row.attempt_count).toBeGreaterThanOrEqual(2);
    expect(row.dispatched_at).not.toEqual(stale);
  });
});
