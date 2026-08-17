import { loadWorkerEnvironment } from "@certificate-platform/config";
import { checkDatabase, closeDatabase, createDatabase } from "@certificate-platform/database";
import {
  checkRedis,
  closeRedis,
  connectRedis,
  createRedisConnection
} from "@certificate-platform/queue";

import { buildWorkerHealthApp } from "./health-app.js";

const environment = loadWorkerEnvironment();
const database = createDatabase({
  connectionString: environment.DATABASE_URL,
  maxConnections: environment.DATABASE_MAX_CONNECTIONS
});
const redis = createRedisConnection({
  url: environment.REDIS_URL,
  connectionName: "certificate-platform-worker"
});

await connectRedis(redis);

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

  app.log.info({ signal }, "shutting down");
  await app.close();
  await Promise.allSettled([closeDatabase(database), closeRedis(redis)]);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: environment.WORKER_HOST, port: environment.WORKER_HEALTH_PORT });
} catch (error) {
  app.log.fatal({ err: error }, "worker startup failed");
  await Promise.allSettled([closeDatabase(database), closeRedis(redis)]);
  process.exitCode = 1;
}
