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
import { createPrivateObjectStorage, createS3Client, ensurePrivateBucket } from "@certificate-platform/storage";

import { buildApi } from "./app.js";
import { createAuthRedisStore } from "./infrastructure/auth-redis-store.js";
import { AuthenticationService } from "./modules/auth/authentication-service.js";
import { OrganizationAuthorizationService } from "./modules/auth/organization-authorization-service.js";
import { PhaseThreeService } from "./modules/phase-three/phase-three-service.js";
import { PhaseFourService } from "./modules/phase-four/phase-four-service.js";

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
const audit = {
  write: (event: Parameters<typeof insertAuditRecord>[1]) => insertAuditRecord(database, event)
};
const authorization = new OrganizationAuthorizationService(authenticationService, audit);
const phaseThreeService = new PhaseThreeService({
  database,
  storage,
  cursorSecret: environment.SESSION_SECRET
});
const phaseFourService = new PhaseFourService({ database, storage, cursorSecret: environment.SESSION_SECRET });

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
  },
  phaseThree: {
    authentication: authenticationService,
    authorization,
    service: phaseThreeService,
    participantImportMaxBytes: environment.PARTICIPANT_IMPORT_MAX_BYTES
  },
  phaseFour: {
    authentication: authenticationService,
    authorization,
    service: phaseFourService,
    templateAssetMaxBytes: environment.TEMPLATE_ASSET_MAX_BYTES
  }
});

let stopping = false;
const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;

  app.log.info({ signal }, "shutting down");
  await app.close();
  s3.destroy();
  await Promise.allSettled([closeDatabase(database), closeRedis(redis)]);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: environment.API_HOST, port: environment.API_PORT });
} catch (error) {
  app.log.fatal({ err: error }, "API startup failed");
  s3.destroy();
  await Promise.allSettled([closeDatabase(database), closeRedis(redis)]);
  process.exitCode = 1;
}
