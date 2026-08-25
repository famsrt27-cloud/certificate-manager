import { randomUUID } from "node:crypto";

import {
  closeDatabase,
  createDatabase,
  createParticipantImport
} from "@certificate-platform/database";
import {
  CERTIFICATE_GENERATION_JOB_NAME,
  CERTIFICATE_GENERATION_QUEUE_NAME,
  closeRedis,
  connectRedis,
  createBullMqRedisConnection,
  createCertificateGenerationProducer,
  createCertificateGenerationWorker,
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

  it("retries certificate generation delivery and keeps one deterministic BullMQ job", async () => {
    const jobId = randomUUID();
    const prefix = `certificate-platform-generation-test-${randomUUID()}`;
    await database.insertInto("jobs").values({
      id: jobId,
      organization_id: organizationId,
      job_type: "CERTIFICATE_GENERATION",
      idempotency_key: `bullmq-generation-${jobId}`,
      requested_by_membership_id: membershipId
    }).execute();
    await database.insertInto("queue_outbox").values({
      organization_id: organizationId,
      message_type: "CERTIFICATE_GENERATION",
      deduplication_key: `${jobId}-generate`,
      payload_json: { version: 1, job_id: jobId, organization_id: organizationId },
      created_at: new Date("1900-01-01T00:00:00.000Z")
    }).execute();

    const failedDispatcher = new QueueOutboxDispatcher({
      database,
      participantImports: { enqueue: async () => undefined, close: async () => undefined },
      certificateGenerations: {
        enqueue: async () => { throw new Error("synthetic Redis outage"); },
        close: async () => undefined
      },
      batchSize: 1,
      retryDelayMs: 0,
      reconcileAfterMs: 100 * 365 * 24 * 60 * 60 * 1_000
    });
    expect(await failedDispatcher.dispatchOnce()).toEqual({ claimed: 1, dispatched: 0, failed: 1 });

    const redis = createBullMqRedisConnection({ url: redisUrl!, connectionName: `generation-producer-${jobId}` });
    await connectRedis(redis);
    const producer = createCertificateGenerationProducer(redis, prefix);
    try {
      const recoveredDispatcher = new QueueOutboxDispatcher({
        database,
        participantImports: { enqueue: async () => undefined, close: async () => undefined },
        certificateGenerations: producer,
        batchSize: 1,
        retryDelayMs: 0,
        reconcileAfterMs: 100 * 365 * 24 * 60 * 60 * 1_000
      });
      expect(await recoveredDispatcher.dispatchOnce()).toEqual({ claimed: 1, dispatched: 1, failed: 0 });
      await database.updateTable("queue_outbox").set({ dispatched_at: null, last_attempt_at: null })
        .where("organization_id", "=", organizationId)
        .where("deduplication_key", "=", `${jobId}-generate`).execute();
      expect(await recoveredDispatcher.dispatchOnce()).toEqual({ claimed: 1, dispatched: 1, failed: 0 });

      const redisJobKey = `${prefix}:${CERTIFICATE_GENERATION_QUEUE_NAME}:${jobId}-generate`;
      expect(await redis.exists(redisJobKey)).toBe(1);
      expect(await redis.hget(redisJobKey, "name")).toBe(CERTIFICATE_GENERATION_JOB_NAME);
      expect(JSON.parse((await redis.hget(redisJobKey, "data"))!)).toEqual({ version: 1, job_id: jobId, organization_id: organizationId });
      const waiting = await redis.lrange(`${prefix}:${CERTIFICATE_GENERATION_QUEUE_NAME}:wait`, 0, -1);
      expect(waiting.filter((id) => id === `${jobId}-generate`)).toHaveLength(1);
      const row = await database.selectFrom("queue_outbox").select(["attempt_count", "dispatched_at", "last_error_code"])
        .where("organization_id", "=", organizationId)
        .where("deduplication_key", "=", `${jobId}-generate`).executeTakeFirstOrThrow();
      expect(row.attempt_count).toBe(3);
      expect(row.dispatched_at).not.toBeNull();
      expect(row.last_error_code).toBeNull();
    } finally {
      await producer.close();
      const keys = await redis.keys(`${prefix}:*`);
      if (keys.length > 0) await redis.del(...keys);
      await closeRedis(redis);
    }
  }, 15_000);

  it("delivers the minimal certificate generation payload through the real consumer", async () => {
    const jobId = randomUUID();
    const prefix = `certificate-platform-generation-consumer-${randomUUID()}`;
    const producerRedis = createBullMqRedisConnection({ url: redisUrl!, connectionName: `generation-consumer-producer-${jobId}` });
    const workerRedis = createBullMqRedisConnection({ url: redisUrl!, connectionName: `generation-consumer-worker-${jobId}` });
    await Promise.all([connectRedis(producerRedis), connectRedis(workerRedis)]);
    const producer = createCertificateGenerationProducer(producerRedis, prefix);
    let resolveDelivery!: (payload: { version: 1; job_id: string; organization_id: string }) => void;
    let rejectDelivery!: (error: Error) => void;
    const delivered = new Promise<{ version: 1; job_id: string; organization_id: string }>((resolve, reject) => {
      resolveDelivery = resolve;
      rejectDelivery = reject;
    });
    const timeout = setTimeout(() => rejectDelivery(new Error("delivery timed out")), 10_000);
    const worker = createCertificateGenerationWorker({ connection: workerRedis, prefix, concurrency: 1,
      process: async (payload) => resolveDelivery(payload), onFinalFailure: async () => undefined });
    try {
      await producer.enqueue({ version: 1, job_id: jobId, organization_id: organizationId });
      expect(await delivered).toEqual({ version: 1, job_id: jobId, organization_id: organizationId });
    } finally {
      clearTimeout(timeout);
      await Promise.allSettled([worker.close(), producer.close()]);
      const keys = await producerRedis.keys(`${prefix}:*`);
      if (keys.length > 0) await producerRedis.del(...keys);
      await Promise.allSettled([closeRedis(producerRedis), closeRedis(workerRedis)]);
    }
  }, 15_000);
});
