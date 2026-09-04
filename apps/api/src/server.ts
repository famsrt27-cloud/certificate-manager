import { createOperationalMetrics, loadApiEnvironment } from "@certificate-platform/config";
import { LoginRateLimiter, MfaSecretCipher, PublicVerificationRateLimiter, RedisMfaChallengeStore,
  RedisSessionStore, hashPassword } from "@certificate-platform/auth";
import {
  checkDatabase,
  closeDatabase,
  createDatabase,
  findPublicCertificateDownload,
  findAdminCertificatePdf,
  findPublicCertificateDownloadAuthorization,
  findPublicCertificatesBySearch,
  suggestPublicCertificateProjects,
  suggestPublicCertificateTrainings,
  findAuthenticationUser,
  findAdminMfaFactor,
  enrollAdminMfaFactor,
  acceptAdminMfaTimestep,
  consumeAdminMfaRecoveryHash,
  findPublicCertificateVerification,
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
import { PhaseFiveService } from "./modules/phase-five/phase-five-service.js";
import { DashboardService } from "./modules/dashboard/dashboard-service.js";
import { OrganizationSettingsService } from "./modules/dashboard/organization-settings-service.js";
import { PublicVerificationService } from "./modules/phase-six/public-verification-service.js";
import { PublicDownloadAuthorizationService } from "./modules/phase-six/public-download-authorization-service.js";
import { PublicCertificateDownloadService } from "./modules/phase-six/public-certificate-download-service.js";
import { AdminCertificatePdfService } from "./modules/phase-six/admin-certificate-pdf-service.js";
import { PublicCertificateSearchService } from "./modules/phase-six/public-certificate-search-service.js";
import { PublicSearchDownloadAuthorizationService } from "./modules/phase-six/public-search-download-authorization-service.js";

const environment = loadApiEnvironment();
const metrics = createOperationalMetrics("api");
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
await ensurePrivateBucket(s3, environment.OBJECT_STORAGE_BUCKET, environment.OBJECT_STORAGE_CREATE_BUCKET, {
  onFailure: () => metrics.recordObjectStorageFailure()
});
const storage = createPrivateObjectStorage(s3, environment.OBJECT_STORAGE_BUCKET, {
  onFailure: () => metrics.recordObjectStorageFailure()
});
const authRedis = createAuthRedisStore(redis, { onFailure: () => metrics.recordRedisSessionFailure() });
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
const mfaCipher = environment.ADMIN_MFA_ENCRYPTION_KEY === undefined
  ? undefined
  : new MfaSecretCipher(environment.ADMIN_MFA_ENCRYPTION_KEY);
const mfaChallenges = environment.ADMIN_MFA_ENCRYPTION_KEY === undefined
  ? undefined
  : new RedisMfaChallengeStore(authRedis, environment.ADMIN_MFA_ENCRYPTION_KEY);
const authenticationService = new AuthenticationService({
  sessions,
  rateLimiter,
  allowedOrigins: environment.ADMIN_ALLOWED_ORIGINS,
  dummyPasswordHash,
  mfaPolicy: environment.ADMIN_MFA_POLICY,
  ...(mfaCipher === undefined || mfaChallenges === undefined ? {} : {
    mfaCipher,
    mfaChallenges,
    mfaFactors: {
      find: (userId: string) => findAdminMfaFactor(database, userId),
      enroll: (userId: string, secret: string, hashes: readonly string[], timestep: number) =>
        enrollAdminMfaFactor(database, userId, secret, hashes, timestep),
      acceptTimestep: (userId: string, timestep: number) => acceptAdminMfaTimestep(database, userId, timestep),
      consumeRecoveryHash: (userId: string, hash: string) => consumeAdminMfaRecoveryHash(database, userId, hash)
    }
  }),
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
const phaseFiveService = new PhaseFiveService({ database, verificationKeyKid: environment.VERIFICATION_ACTIVE_KID,
  cursorSecret: environment.SESSION_SECRET });
const dashboardService = new DashboardService(database);
const organizationSettingsService = new OrganizationSettingsService(database);
const publicVerificationService = new PublicVerificationService({
  verificationKeys: new Map(Object.entries(environment.VERIFICATION_SIGNING_KEYS_JSON)),
  repository: { findByPublicIdentifier: (publicIdentifier) => findPublicCertificateVerification(database, publicIdentifier) }
});
const publicVerificationRateLimiter = new PublicVerificationRateLimiter(authRedis, {
  secret: environment.SESSION_SECRET,
  windowSeconds: environment.PUBLIC_VERIFICATION_RATE_LIMIT_WINDOW_SECONDS,
  networkMaximum: environment.PUBLIC_VERIFICATION_RATE_LIMIT_NETWORK_MAX
});
const activeVerificationSigningKey = environment.VERIFICATION_SIGNING_KEYS_JSON[environment.VERIFICATION_ACTIVE_KID];
if (activeVerificationSigningKey === undefined) throw new Error("Active verification signing key is unavailable");
const publicDownloadAuthorizationService = new PublicDownloadAuthorizationService({
  verificationKeys: new Map(Object.entries(environment.VERIFICATION_SIGNING_KEYS_JSON)),
  activeSigningKeyId: environment.VERIFICATION_ACTIVE_KID,
  activeSigningKey: activeVerificationSigningKey,
  ttlSeconds: environment.PUBLIC_DOWNLOAD_TOKEN_TTL_SECONDS,
  repository: { findByPublicIdentifier: (publicIdentifier) =>
    findPublicCertificateDownloadAuthorization(database, publicIdentifier) }
});
const publicDownloadAuthorizationRateLimiter = new PublicVerificationRateLimiter(authRedis, {
  secret: environment.SESSION_SECRET,
  windowSeconds: environment.PUBLIC_DOWNLOAD_AUTHORIZE_RATE_LIMIT_WINDOW_SECONDS,
  networkMaximum: environment.PUBLIC_DOWNLOAD_AUTHORIZE_RATE_LIMIT_NETWORK_MAX,
  keyPrefix: "public:download-authorize-rate:v1:"
});
const publicCertificateDownloadService = new PublicCertificateDownloadService({
  verificationKeys: new Map(Object.entries(environment.VERIFICATION_SIGNING_KEYS_JSON)),
  repository: { findByPublicIdentifier: (publicIdentifier) =>
    findPublicCertificateDownload(database, publicIdentifier) },
  storage,
  maximumPdfBytes: environment.CERTIFICATE_PDF_MAX_BYTES
});
const adminCertificatePdfService = new AdminCertificatePdfService({
  repository: { findByOrganizationAndId: (organizationId, certificateId) =>
    findAdminCertificatePdf(database, organizationId, certificateId) },
  storage,
  maximumPdfBytes: environment.CERTIFICATE_PDF_MAX_BYTES
});
const publicCertificateDownloadRateLimiter = new PublicVerificationRateLimiter(authRedis, {
  secret: environment.SESSION_SECRET,
  windowSeconds: environment.PUBLIC_DOWNLOAD_RATE_LIMIT_WINDOW_SECONDS,
  networkMaximum: environment.PUBLIC_DOWNLOAD_RATE_LIMIT_NETWORK_MAX,
  keyPrefix: "public:download-rate:v1:"
});
const publicCertificateSearchService = new PublicCertificateSearchService({
  repository: {
    search: (criteria, limit) => findPublicCertificatesBySearch(database, criteria, limit),
    suggestProjects: (query, limit) => suggestPublicCertificateProjects(database, query, limit),
    suggestTrainings: (projectName, query, limit) =>
      suggestPublicCertificateTrainings(database, projectName, query, limit)
  },
  activeSigningKeyId: environment.VERIFICATION_ACTIVE_KID,
  activeSigningKey: activeVerificationSigningKey,
  ttlSeconds: environment.PUBLIC_SEARCH_RESULT_TOKEN_TTL_SECONDS
});
const publicCertificateSearchRateLimiter = new PublicVerificationRateLimiter(authRedis, {
  secret: environment.SESSION_SECRET,
  windowSeconds: environment.PUBLIC_CERTIFICATE_SEARCH_RATE_LIMIT_WINDOW_SECONDS,
  networkMaximum: environment.PUBLIC_CERTIFICATE_SEARCH_RATE_LIMIT_NETWORK_MAX,
  keyPrefix: "public:certificate-search-rate:v1:"
});
const publicProjectSuggestionRateLimiter = new PublicVerificationRateLimiter(authRedis, {
  secret: environment.SESSION_SECRET,
  windowSeconds: environment.PUBLIC_CERTIFICATE_SUGGESTION_RATE_LIMIT_WINDOW_SECONDS,
  networkMaximum: environment.PUBLIC_CERTIFICATE_SUGGESTION_RATE_LIMIT_NETWORK_MAX,
  keyPrefix: "public:project-suggestion-rate:v1:"
});
const publicTrainingSuggestionRateLimiter = new PublicVerificationRateLimiter(authRedis, {
  secret: environment.SESSION_SECRET,
  windowSeconds: environment.PUBLIC_CERTIFICATE_SUGGESTION_RATE_LIMIT_WINDOW_SECONDS,
  networkMaximum: environment.PUBLIC_CERTIFICATE_SUGGESTION_RATE_LIMIT_NETWORK_MAX,
  keyPrefix: "public:training-suggestion-rate:v1:"
});
const publicSearchDownloadAuthorizationService = new PublicSearchDownloadAuthorizationService({
  verificationKeys: new Map(Object.entries(environment.VERIFICATION_SIGNING_KEYS_JSON)),
  activeSigningKeyId: environment.VERIFICATION_ACTIVE_KID,
  activeSigningKey: activeVerificationSigningKey,
  downloadTtlSeconds: environment.PUBLIC_DOWNLOAD_TOKEN_TTL_SECONDS,
  repository: { findByPublicIdentifier: (identifier) =>
    findPublicCertificateDownloadAuthorization(database, identifier) }
});
const publicSearchDownloadAuthorizationRateLimiter = new PublicVerificationRateLimiter(authRedis, {
  secret: environment.SESSION_SECRET,
  windowSeconds: environment.PUBLIC_SEARCH_DOWNLOAD_AUTHORIZE_RATE_LIMIT_WINDOW_SECONDS,
  networkMaximum: environment.PUBLIC_SEARCH_DOWNLOAD_AUTHORIZE_RATE_LIMIT_NETWORK_MAX,
  keyPrefix: "public:search-download-authorize-rate:v1:"
});

const app = buildApi({
  dependencies: {
    checkDatabase: () => checkDatabase(database),
    checkRedis: () => checkRedis(redis)
  },
  readinessTimeoutMs: environment.READINESS_TIMEOUT_MS,
  logLevel: environment.LOG_LEVEL,
  metrics,
  trustedProxyHops: environment.API_TRUST_PROXY_HOPS,
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
  },
  phaseFive: { authentication: authenticationService, authorization, service: phaseFiveService,
    certificatePdf: adminCertificatePdfService },
  dashboard: { authentication: authenticationService, authorization, service: dashboardService },
  organizationSettings: { authentication: authenticationService, authorization,
    service: organizationSettingsService },
  publicVerification: { service: publicVerificationService, rateLimiter: publicVerificationRateLimiter },
  publicDownloadAuthorization: { service: publicDownloadAuthorizationService,
    rateLimiter: publicDownloadAuthorizationRateLimiter },
  publicCertificateDownload: { service: publicCertificateDownloadService,
    rateLimiter: publicCertificateDownloadRateLimiter },
  publicCertificateSearch: { service: publicCertificateSearchService,
    rateLimiter: publicCertificateSearchRateLimiter,
    projectSuggestionRateLimiter: publicProjectSuggestionRateLimiter,
    trainingSuggestionRateLimiter: publicTrainingSuggestionRateLimiter },
  publicSearchDownloadAuthorization: { service: publicSearchDownloadAuthorizationService,
    rateLimiter: publicSearchDownloadAuthorizationRateLimiter }
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
