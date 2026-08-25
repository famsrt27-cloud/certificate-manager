import { loadWorkerEnvironment } from "@certificate-platform/config";
import { checkDatabase, cleanupExpiredParticipantImports, closeDatabase, createDatabase } from "@certificate-platform/database";
import {
  checkRedis,
  closeRedis,
  connectRedis,
  createBullMqRedisConnection,
  createParticipantImportProducer,
  createParticipantImportWorker,
  createRedisConnection
} from "@certificate-platform/queue";
import { createPrivateObjectStorage, createS3Client, ensurePrivateBucket } from "@certificate-platform/storage";

import { buildWorkerHealthApp } from "./health-app.js";
import { ParticipantImportSourceCleanupReconciler } from "./participant-import-source-cleanup-reconciler.js";
import { ParticipantImportProcessor } from "./processors/participant-import-processor.js";
import { QueueOutboxDispatcher } from "./queue-outbox-dispatcher.js";
import { StorageCleanupReconciler } from "./storage-cleanup-reconciler.js";

const environment = loadWorkerEnvironment();
const database = createDatabase({
  connectionString: environment.DATABASE_URL,
  maxConnections: environment.DATABASE_MAX_CONNECTIONS
});
const redis = createRedisConnection({
  url: environment.REDIS_URL,
  connectionName: "certificate-platform-worker"
});
const queueRedis = createBullMqRedisConnection({
  url: environment.REDIS_URL,
  connectionName: "certificate-platform-worker-participant-import"
});
const dispatcherRedis = createBullMqRedisConnection({
  url: environment.REDIS_URL,
  connectionName: "certificate-platform-worker-outbox-dispatcher"
});

await Promise.all([connectRedis(redis), connectRedis(queueRedis), connectRedis(dispatcherRedis)]);
const s3 = createS3Client({
  endpoint: environment.OBJECT_STORAGE_ENDPOINT,
  region: environment.OBJECT_STORAGE_REGION,
  bucket: environment.OBJECT_STORAGE_BUCKET,
  accessKeyId: environment.OBJECT_STORAGE_ACCESS_KEY,
  secretAccessKey: environment.OBJECT_STORAGE_SECRET_KEY,
  forcePathStyle: environment.OBJECT_STORAGE_FORCE_PATH_STYLE
});
await ensurePrivateBucket(s3, environment.OBJECT_STORAGE_BUCKET, environment.OBJECT_STORAGE_CREATE_BUCKET);
const storage = createPrivateObjectStorage(s3, environment.OBJECT_STORAGE_BUCKET);
const participantImportProcessor = new ParticipantImportProcessor({
  database,
  storage,
  maximumBytes: environment.PARTICIPANT_IMPORT_MAX_BYTES,
  maximumRows: environment.PARTICIPANT_IMPORT_MAX_ROWS,
  maximumUncompressedBytes: environment.PARTICIPANT_IMPORT_MAX_UNCOMPRESSED_BYTES
});
const participantImportWorker = createParticipantImportWorker({
  connection: queueRedis,
  prefix: environment.BULLMQ_PREFIX,
  concurrency: environment.PARTICIPANT_IMPORT_CONCURRENCY,
  process: (payload) => participantImportProcessor.process(payload),
  onFinalFailure: (payload) => participantImportProcessor.handleFinalFailure(payload)
});
const participantImports = createParticipantImportProducer(dispatcherRedis, environment.BULLMQ_PREFIX);
const queueOutboxDispatcher = new QueueOutboxDispatcher({
  database,
  participantImports,
  batchSize: 100,
  retryDelayMs: 5_000,
  reconcileAfterMs: 30_000
});
const storageCleanupReconciler = new StorageCleanupReconciler({
  database,
  storage,
  batchSize: 100,
  retryDelayMs: 30_000
});
const participantImportSourceCleanupReconciler = new ParticipantImportSourceCleanupReconciler({
  database,
  storage,
  batchSize: 100,
  retryDelayMs: 30_000
});
const cleanupParticipantImports = async (): Promise<void> => {
  const cutoff = new Date(Date.now() - environment.PARTICIPANT_IMPORT_RETENTION_HOURS * 60 * 60 * 1_000);
  await cleanupExpiredParticipantImports(database, cutoff);
};
await cleanupParticipantImports();
const participantImportCleanupTimer = setInterval(() => void cleanupParticipantImports().catch(() => undefined), 60 * 60 * 1_000);
participantImportCleanupTimer.unref();

const app = buildWorkerHealthApp({
  dependencies: {
    checkDatabase: () => checkDatabase(database),
    checkRedis: () => checkRedis(redis)
  },
  readinessTimeoutMs: environment.READINESS_TIMEOUT_MS,
  logLevel: environment.LOG_LEVEL
});

let dispatchPromise: Promise<void> | null = null;
const dispatchOutbox = (): Promise<void> => {
  if (dispatchPromise !== null) return dispatchPromise;
  const run = queueOutboxDispatcher.dispatchOnce()
    .then((result) => {
      if (result.failed > 0) {
        app.log.warn({ result }, "queue outbox dispatch completed with failures");
      }
    })
    .catch((error: unknown) => {
      app.log.warn({ err: error }, "queue outbox dispatch failed");
    })
    .finally(() => {
      dispatchPromise = null;
    });
  dispatchPromise = run;
  return run;
};
await dispatchOutbox();
const queueOutboxDispatchTimer = setInterval(() => void dispatchOutbox(), 1_000);
queueOutboxDispatchTimer.unref();

let storageCleanupPromise: Promise<void> | null = null;
const reconcileStorageCleanup = (): Promise<void> => {
  if (storageCleanupPromise !== null) return storageCleanupPromise;
  const run = storageCleanupReconciler.runOnce()
    .then((result) => {
      if (result.failed > 0) app.log.warn({ result }, "storage cleanup reconciliation completed with failures");
    })
    .catch((error: unknown) => {
      app.log.warn({ err: error }, "storage cleanup reconciliation failed");
    })
    .finally(() => {
      storageCleanupPromise = null;
    });
  storageCleanupPromise = run;
  return run;
};
await reconcileStorageCleanup();
const storageCleanupTimer = setInterval(() => void reconcileStorageCleanup(), 30_000);
storageCleanupTimer.unref();

let participantImportSourceCleanupPromise: Promise<void> | null = null;
const reconcileParticipantImportSourceCleanup = (): Promise<void> => {
  if (participantImportSourceCleanupPromise !== null) return participantImportSourceCleanupPromise;
  const run = participantImportSourceCleanupReconciler.runOnce()
    .then((result) => {
      if (result.failed > 0) {
        app.log.warn({ result }, "participant import source cleanup completed with failures");
      }
    })
    .catch((error: unknown) => {
      app.log.warn({ err: error }, "participant import source cleanup reconciliation failed");
    })
    .finally(() => {
      participantImportSourceCleanupPromise = null;
    });
  participantImportSourceCleanupPromise = run;
  return run;
};
await reconcileParticipantImportSourceCleanup();
const participantImportSourceCleanupTimer = setInterval(
  () => void reconcileParticipantImportSourceCleanup(),
  30_000
);
participantImportSourceCleanupTimer.unref();

let stopping = false;
const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  clearInterval(participantImportCleanupTimer);
  clearInterval(queueOutboxDispatchTimer);
  clearInterval(storageCleanupTimer);
  clearInterval(participantImportSourceCleanupTimer);

  app.log.info({ signal }, "shutting down");
  await app.close();
  if (dispatchPromise !== null) await dispatchPromise;
  if (storageCleanupPromise !== null) await storageCleanupPromise;
  if (participantImportSourceCleanupPromise !== null) await participantImportSourceCleanupPromise;
  await Promise.allSettled([participantImportWorker.close(), participantImports.close()]);
  s3.destroy();
  await Promise.allSettled([
    closeDatabase(database),
    closeRedis(redis),
    closeRedis(queueRedis),
    closeRedis(dispatcherRedis)
  ]);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: environment.WORKER_HOST, port: environment.WORKER_HEALTH_PORT });
} catch (error) {
  app.log.fatal({ err: error }, "worker startup failed");
  clearInterval(queueOutboxDispatchTimer);
  clearInterval(storageCleanupTimer);
  clearInterval(participantImportSourceCleanupTimer);
  if (dispatchPromise !== null) await dispatchPromise;
  if (storageCleanupPromise !== null) await storageCleanupPromise;
  if (participantImportSourceCleanupPromise !== null) await participantImportSourceCleanupPromise;
  await Promise.allSettled([participantImportWorker.close(), participantImports.close()]);
  s3.destroy();
  await Promise.allSettled([
    closeDatabase(database),
    closeRedis(redis),
    closeRedis(queueRedis),
    closeRedis(dispatcherRedis)
  ]);
  process.exitCode = 1;
}
