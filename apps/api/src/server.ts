import { loadApiEnvironment } from "@certificate-platform/config";
import { LoginRateLimiter, RedisSessionStore, hashPassword } from "@certificate-platform/auth";
import {
  checkDatabase,
  closeDatabase,
  createDatabase,
  findAuthenticationUser,
  insertAuditRecord,
  loadEffectiveIdentity
} from "@certificate-platform/database";
import {
  checkRedis,
  closeRedis,
  connectRedis,
  createRedisConnection
} from "@certificate-platform/queue";

import { buildApi } from "./app.js";
import { createAuthRedisStore } from "./infrastructure/auth-redis-store.js";
import { AuthenticationService } from "./modules/auth/authentication-service.js";

const environment = loadApiEnvironment();
const database = createDatabase({
  connectionString: environment.DATABASE_URL,
  maxConnections: environment.DATABASE_MAX_CONNECTIONS
});
const redis = createRedisConnection({
  url: environment.REDIS_URL,
  connectionName: "certificate-platform-api"
});

await connectRedis(redis);
const authRedis = createAuthRedisStore(redis);
const sessions = new RedisSessionStore({
  redis: authRedis,
  configuration: {
    secret: environment.SESSION_SECRET,
    idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS,
    absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS
  }
});
const rateLimiter = new LoginRateLimiter(authRedis, {
  secret: environment.SESSION_SECRET,
  windowSeconds: environment.LOGIN_RATE_LIMIT_WINDOW_SECONDS,
  accountMaximum: environment.LOGIN_RATE_LIMIT_ACCOUNT_MAX,
  networkMaximum: environment.LOGIN_RATE_LIMIT_NETWORK_MAX
});
const dummyPasswordHash = await hashPassword("constant-dummy-authentication-password", environment.BCRYPT_COST);
const authenticationService = new AuthenticationService({
  sessions,
  rateLimiter,
  allowedOrigins: environment.ADMIN_ALLOWED_ORIGINS,
  dummyPasswordHash,
  identities: {
    findByNormalizedEmail: (email) => findAuthenticationUser(database, email),
    loadEffectiveIdentity: (userId) => loadEffectiveIdentity(database, userId)
  },
  audit: {
    write: (event) => insertAuditRecord(database, {
      organizationId: event.organizationId,
      actorUserId: event.actorUserId,
      actorMembershipId: event.actorMembershipId,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      requestId: event.requestId,
      metadata: event.metadata
    })
  }
});

const app = buildApi({
  dependencies: {
    checkDatabase: () => checkDatabase(database),
    checkRedis: () => checkRedis(redis)
  },
  readinessTimeoutMs: environment.READINESS_TIMEOUT_MS,
  logLevel: environment.LOG_LEVEL,
  authentication: {
    service: authenticationService,
    absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS
  }
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
  await app.listen({ host: environment.API_HOST, port: environment.API_PORT });
} catch (error) {
  app.log.fatal({ err: error }, "API startup failed");
  await Promise.allSettled([closeDatabase(database), closeRedis(redis)]);
  process.exitCode = 1;
}
