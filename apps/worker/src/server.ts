import { loadWorkerEnvironment } from "@certificate-platform/config";
import { checkDatabase, cleanupExpiredParticipantImports, closeDatabase, createDatabase } from "@certificate-platform/database";
import {
  checkRedis,
  closeRedis,
  connectRedis,
  createBullMqRedisConnection,
  createParticipantImportWorker,
  createRedisConnection
} from "@certificate-platform/queue";
import { createPrivateObjectStorage, createS3Client, ensurePrivateBucket } from "@certificate-platform/storage";

import { buildWorkerHealthApp } from "./health-app.js";
import { ParticipantImportProcessor } from "./processors/participant-import-processor.js";

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

await Promise.all([connectRedis(redis), connectRedis(queueRedis)]);
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
const cleanupParticipantImports = async (): Promise<void> => {
  const cutoff = new Date(Date.now() - environment.PARTICIPANT_IMPORT_RETENTION_HOURS * 60 * 60 * 1_000);
  const storageKeys = await cleanupExpiredParticipantImports(database, cutoff);
  await Promise.allSettled(storageKeys.map((key) => storage.delete(key)));
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

let stopping = false;
const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  clearInterval(participantImportCleanupTimer);

  app.log.info({ signal }, "shutting down");
  await app.close();
  await participantImportWorker.close();
  s3.destroy();
  await Promise.allSettled([closeDatabase(database), closeRedis(redis), closeRedis(queueRedis)]);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: environment.WORKER_HOST, port: environment.WORKER_HEALTH_PORT });
} catch (error) {
  app.log.fatal({ err: error }, "worker startup failed");
  await participantImportWorker.close().catch(() => undefined);
  s3.destroy();
  await Promise.allSettled([closeDatabase(database), closeRedis(redis), closeRedis(queueRedis)]);
  process.exitCode = 1;
}
