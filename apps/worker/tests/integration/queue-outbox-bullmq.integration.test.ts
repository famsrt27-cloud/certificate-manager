import { randomUUID } from "node:crypto";

import {
  closeDatabase,
  createDatabase,
  createParticipantImport
} from "@certificate-platform/database";
import {
  closeRedis,
  connectRedis,
  createBullMqRedisConnection,
  createParticipantImportProducer,
  createParticipantImportWorker,
  type ParticipantImportJobPayload,
  type ParticipantImportProducer
} from "@certificate-platform/queue";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { QueueOutboxDispatcher } from "../../src/queue-outbox-dispatcher.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const integrationEnabled = databaseUrl !== undefined
  && new URL(databaseUrl).pathname.toLowerCase().includes("test")
  && redisUrl !== undefined;

describe.skipIf(!integrationEnabled)("queue outbox real BullMQ integration", () => {
  const database = createDatabase({ connectionString: databaseUrl!, maxConnections: 3 });
  const organizationId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const projectId = randomUUID();
  const trainingId = randomUUID();

  beforeAll(async () => {
    await database.insertInto("users").values({
      id: userId,
      email: `bullmq-${randomUUID()}@example.invalid`,
      password_hash: "synthetic"
    }).execute();
    await database.insertInto("organizations").values({
      id: organizationId,
      name: "Synthetic BullMQ Tenant"
    }).execute();
    await database.insertInto("organization_memberships").values({
      id: membershipId,
      organization_id: organizationId,
      user_id: userId
    }).execute();
    await database.insertInto("projects").values({
      id: projectId,
      organization_id: organizationId,
      name: "Synthetic BullMQ Project",
      slug: `bullmq-${randomUUID()}`
    }).execute();
    await database.insertInto("trainings").values({
      id: trainingId,
      organization_id: organizationId,
      project_id: projectId,
      name: "Synthetic BullMQ Training",
      code: `BULLMQ-${randomUUID()}`
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

  it("recovers a durable PostgreSQL intent through a real BullMQ producer and worker", async () => {
    const jobId = randomUUID();
    const prefix = `certificate-platform-test-${randomUUID()}`;
    await createParticipantImport(database, {
      jobId,
      organizationId,
      trainingId,
      idempotencyKey: `bullmq-${jobId}`,
      requestedByMembershipId: membershipId,
      sourceStorageKey: `participant-imports/${organizationId}/${jobId}/source.csv`,
      originalFilename: "source.csv",
      contentSha256: new Uint8Array(32).fill(5),
      detectedMimeType: "text/csv",
      sizeBytes: 128
    });

    // Make this test record deterministically first without touching unrelated test data.
    await database.updateTable("queue_outbox").set({
      created_at: new Date("1900-01-01T00:00:00.000Z")
    }).where("organization_id", "=", organizationId)
      .where("deduplication_key", "=", `${jobId}-validate`).execute();

    const unavailableProducer: ParticipantImportProducer = {
      enqueue: async () => { throw new Error("synthetic Redis outage"); },
      close: async () => undefined
    };
    const failedDispatcher = new QueueOutboxDispatcher({
      database,
      participantImports: unavailableProducer,
      batchSize: 1,
      retryDelayMs: 0,
      reconcileAfterMs: 100 * 365 * 24 * 60 * 60 * 1_000
    });
    expect(await failedDispatcher.dispatchOnce()).toEqual({ claimed: 1, dispatched: 0, failed: 1 });

    const producerRedis = createBullMqRedisConnection({
      url: redisUrl!,
      connectionName: `outbox-test-producer-${jobId}`
    });
    const workerRedis = createBullMqRedisConnection({
      url: redisUrl!,
      connectionName: `outbox-test-worker-${jobId}`
    });
    await Promise.all([connectRedis(producerRedis), connectRedis(workerRedis)]);

    const producer = createParticipantImportProducer(producerRedis, prefix);
    let resolveDelivery!: (payload: ParticipantImportJobPayload) => void;
    let rejectDelivery!: (error: Error) => void;
    const delivery = new Promise<ParticipantImportJobPayload>((resolve, reject) => {
      resolveDelivery = resolve;
      rejectDelivery = reject;
    });
    const timeout = setTimeout(() => rejectDelivery(new Error("BullMQ delivery timed out")), 10_000);

    const worker = createParticipantImportWorker({
      connection: workerRedis,
      prefix,
      concurrency: 1,
      process: async (payload) => {
        if (payload.job_id !== jobId) return;
        await database.updateTable("jobs").set({ started_at: new Date() })
          .where("organization_id", "=", organizationId)
          .where("id", "=", jobId)
          .execute();
        resolveDelivery(payload);
      },
      onFinalFailure: async (_payload, error) => {
        rejectDelivery(error);
      }
    });

    try {
      const recoveredDispatcher = new QueueOutboxDispatcher({
        database,
        participantImports: producer,
        batchSize: 1,
        retryDelayMs: 0,
        reconcileAfterMs: 100 * 365 * 24 * 60 * 60 * 1_000
      });
      expect(await recoveredDispatcher.dispatchOnce()).toEqual({ claimed: 1, dispatched: 1, failed: 0 });

      expect(await delivery).toEqual({
        version: 1,
        job_id: jobId,
        organization_id: organizationId,
        operation: "VALIDATE"
      });

      const row = await database.selectFrom("queue_outbox")
        .select(["attempt_count", "dispatched_at", "last_error_code"])
        .where("organization_id", "=", organizationId)
        .where("deduplication_key", "=", `${jobId}-validate`)
        .executeTakeFirstOrThrow();
      expect(row.attempt_count).toBeGreaterThanOrEqual(2);
      expect(row.dispatched_at).not.toBeNull();
      expect(row.last_error_code).toBeNull();
    } finally {
      clearTimeout(timeout);
      await Promise.allSettled([worker.close(), producer.close()]);
      const keys = await producerRedis.keys(`${prefix}:*`);
      if (keys.length > 0) await producerRedis.del(...keys);
      await Promise.allSettled([closeRedis(producerRedis), closeRedis(workerRedis)]);
    }
  }, 15_000);
});
