import { createHash, randomUUID } from "node:crypto";

import { PublicVerificationRateLimiter } from "@certificate-platform/auth";
import { closeDatabase, createDatabase, findPublicCertificateDownload,
  findPublicCertificateDownloadAuthorization, findPublicCertificateVerification } from "@certificate-platform/database";
import { createCertificateDownloadToken, createCertificateVerificationToken } from "@certificate-platform/domain";
import { closeRedis, connectRedis, createRedisConnection } from "@certificate-platform/queue";
import { createPrivateObjectStorage, createS3Client, ensurePrivateBucket } from "@certificate-platform/storage";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApi } from "../../src/app.js";
import { createAuthRedisStore } from "../../src/infrastructure/auth-redis-store.js";
import { PublicCertificateDownloadService } from "../../src/modules/phase-six/public-certificate-download-service.js";
import { PublicDownloadAuthorizationService } from "../../src/modules/phase-six/public-download-authorization-service.js";
import { PublicVerificationService } from "../../src/modules/phase-six/public-verification-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const storageConfiguration = {
  endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
  bucket: process.env.OBJECT_STORAGE_BUCKET,
  accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY,
  secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY,
  region: process.env.OBJECT_STORAGE_REGION ?? "us-east-1"
};
const enabled = databaseUrl !== undefined && redisUrl !== undefined
  && new URL(databaseUrl).pathname.toLowerCase().includes("test")
  && storageConfiguration.endpoint !== undefined && storageConfiguration.bucket !== undefined
  && storageConfiguration.accessKeyId !== undefined && storageConfiguration.secretAccessKey !== undefined;
if (process.env.CI && !enabled) {
  throw new Error("Phase 6 secure-download integration requires PostgreSQL, Redis, and private object storage in CI");
}

describe.skipIf(!enabled)("public certificate secure download integration", () => {
  const database = createDatabase({ connectionString: databaseUrl!, maxConnections: 6 });
  const redis = createRedisConnection({ url: redisUrl!, connectionName: `phase-six-download-${randomUUID()}` });
  const redisStore = createAuthRedisStore(redis);
  const s3 = createS3Client({ endpoint: storageConfiguration.endpoint!, region: storageConfiguration.region,
    bucket: storageConfiguration.bucket!, accessKeyId: storageConfiguration.accessKeyId!,
    secretAccessKey: storageConfiguration.secretAccessKey!, forcePathStyle: true });
  const storage = createPrivateObjectStorage(s3, storageConfiguration.bucket!);
  const activeKey = Buffer.alloc(32, 61);
  const previousKey = Buffer.alloc(32, 62);
  const verificationKeys = new Map<string, Uint8Array>([["active-key", activeKey], ["previous-key", previousKey]]);
  const rateLimitSecret = "phase-six-download-integration-secret-at-least-32-bytes";
  const plannedIssuedAt = new Date("2026-08-26T08:00:00.000Z");
  const authorizationNow = new Date("2026-08-26T10:00:00.000Z");
  const organizationId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const projectId = randomUUID();
  const trainingId = randomUUID();
  const templateId = randomUUID();
  const templateVersionId = randomUUID();
  const objectKeys: string[] = [];
  let app: ReturnType<typeof buildApi>;

  const createAvailableCertificate = async (label: string, expectedPdf: Uint8Array, storedPdf = expectedPdf) => {
    const participantId = randomUUID();
    const certificateId = randomUUID();
    const jobId = randomUUID();
    const publicIdentifier = randomUUID().replaceAll("-", "").toLowerCase();
    const objectKey = `phase-six/${organizationId}/${certificateId}.pdf`;
    const expectedHash = createHash("sha256").update(expectedPdf).digest();
    objectKeys.push(objectKey);
    await storage.put({ key: objectKey, body: storedPdf, contentType: "application/pdf",
      contentSha256Hex: createHash("sha256").update(storedPdf).digest("hex") });
    await database.insertInto("participants").values({ id: participantId, organization_id: organizationId,
      display_name: `Synthetic ${label}`, external_reference: null }).execute();
    await database.insertInto("training_participants").values({ organization_id: organizationId, training_id: trainingId,
      participant_id: participantId, source_import_job_id: null }).execute();
    await database.insertInto("certificates").values({ id: certificateId, public_identifier: publicIdentifier,
      organization_id: organizationId, training_id: trainingId, participant_id: participantId,
      template_version_id: templateVersionId, certificate_number: `P6-${randomUUID()}`,
      verification_key_kid: "active-key" }).execute();
    await database.insertInto("certificate_issuance_snapshots").values({ certificate_id: certificateId,
      organization_id: organizationId, recipient_display_name: `Snapshot ${label}`, project_name: "Phase Six Program",
      training_name: "Phase Six Training", training_code: "P6", issued_at: plannedIssuedAt }).execute();
    await database.updateTable("certificates").set({ status: "GENERATING", updated_at: new Date() })
      .where("id", "=", certificateId).execute();
    await database.insertInto("jobs").values({ id: jobId, organization_id: organizationId,
      job_type: "CERTIFICATE_GENERATION", idempotency_key: `phase-six-${randomUUID()}`,
      requested_by_membership_id: membershipId }).execute();
    await database.insertInto("certificate_generation_jobs").values({ job_id: jobId, organization_id: organizationId,
      training_id: trainingId, template_version_id: templateVersionId, generation_revision: 1,
      selection_mode: "EXPLICIT", request_fingerprint: Buffer.alloc(32, 4), renderer_revision: "pdfkit-qrcode-v1" }).execute();
    await database.insertInto("certificate_generation_items").values({ organization_id: organizationId, job_id: jobId,
      certificate_id: certificateId, generation_revision: 1, status: "SUCCEEDED" }).execute();
    await database.updateTable("certificates").set({ status: "AVAILABLE", issued_at: plannedIssuedAt,
      pdf_storage_key: objectKey, pdf_content_sha256: expectedHash, pdf_size_bytes: String(expectedPdf.byteLength),
      pdf_mime_type: "application/pdf", updated_at: new Date() }).where("id", "=", certificateId).execute();
    return { certificateId, publicIdentifier, objectKey, expectedHash };
  };

  const verificationTokenFor = (publicIdentifier: string) => createCertificateVerificationToken({
    keyId: "active-key", key: activeKey, publicIdentifier, issuedAt: plannedIssuedAt
  });
  const limiter = (prefix: string, maximum = 100) => new PublicVerificationRateLimiter(redisStore, {
    secret: rateLimitSecret, windowSeconds: 60, networkMaximum: maximum,
    keyPrefix: `test:phase-six:${prefix}:${randomUUID()}:`
  });
  const buildPublicApp = (now: () => Date = () => authorizationNow) => buildApi({
    dependencies: { checkDatabase: async () => undefined, checkRedis: async () => undefined },
    readinessTimeoutMs: 1_000,
    logger: false,
    publicVerification: { rateLimiter: limiter("verify"), service: new PublicVerificationService({ verificationKeys,
      repository: { findByPublicIdentifier: (identifier) => findPublicCertificateVerification(database, identifier) } }) },
    publicDownloadAuthorization: { rateLimiter: limiter("authorize"),
      service: new PublicDownloadAuthorizationService({ verificationKeys, activeSigningKeyId: "active-key",
        activeSigningKey: activeKey, ttlSeconds: 60, now,
        repository: { findByPublicIdentifier: (identifier) =>
          findPublicCertificateDownloadAuthorization(database, identifier) } }) },
    publicCertificateDownload: { rateLimiter: limiter("download"),
      service: new PublicCertificateDownloadService({ verificationKeys, maximumPdfBytes: 10 * 1_024 * 1_024,
        now, storage, repository: { findByPublicIdentifier: (identifier) =>
          findPublicCertificateDownload(database, identifier) } }) }
  });

  beforeAll(async () => {
    await connectRedis(redis);
    await ensurePrivateBucket(s3, storageConfiguration.bucket!, true);
    await database.insertInto("users").values({ id: userId,
      email: `phase-six-download-${randomUUID()}@example.invalid`, password_hash: "synthetic" }).execute();
    await database.insertInto("organizations").values({ id: organizationId, name: "Phase Six Download Tenant" }).execute();
    await database.insertInto("organization_memberships").values({ id: membershipId,
      organization_id: organizationId, user_id: userId }).execute();
    await database.insertInto("projects").values({ id: projectId, organization_id: organizationId,
      name: "Phase Six Project", slug: `phase-six-${randomUUID()}` }).execute();
    await database.insertInto("trainings").values({ id: trainingId, organization_id: organizationId,
      project_id: projectId, name: "Phase Six Training", code: `P6-${randomUUID()}` }).execute();
    await database.insertInto("certificate_templates").values({ id: templateId, organization_id: organizationId,
      name: "Phase Six Template" }).execute();
    await database.insertInto("template_versions").values({ id: templateVersionId, organization_id: organizationId,
      template_id: templateId, version: 1, definition_json: { format_version: 1 }, status: "PUBLISHED",
      published_at: new Date() }).execute();
    app = buildPublicApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await Promise.allSettled(objectKeys.map((key) => storage.delete(key)));
    s3.destroy();
    await Promise.allSettled([closeDatabase(database), closeRedis(redis)]);
  });

  it("proves verify -> authorize -> bounded private MinIO redemption with exact bytes and headers", async () => {
    const pdf = Buffer.from("%PDF-1.7\nreal private Phase 6 certificate\n%%EOF", "ascii");
    const certificate = await createAvailableCertificate("Full Flow", pdf);
    const verificationToken = verificationTokenFor(certificate.publicIdentifier);
    const verified = await request(app.server).post("/api/public/verify").send({ token: verificationToken });
    expect(verified.status).toBe(200);
    expect(verified.body.data.status).toBe("valid");
    const authorization = await request(app.server).post("/api/public/certificates/download-authorize")
      .send({ token: verificationToken });
    expect(authorization.status).toBe(200);
    const response = await request(app.server).post("/api/public/certificates/download")
      .send({ download_token: authorization.body.data.download_token });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(pdf);
    expect(createHash("sha256").update(response.body as Buffer).digest()).toEqual(certificate.expectedHash);
    expect((response.body as Buffer).byteLength).toBe(pdf.byteLength);
    expect((response.body as Buffer).subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.headers["content-disposition"]).toBe('attachment; filename="certificate.pdf"');
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
    expect(Object.keys(authorization.body).sort()).toEqual(["data", "meta"]);
    expect(Object.keys(authorization.body.data).sort()).toEqual(["download_token", "expires_in"]);
    expect(Object.keys(authorization.body.meta)).toEqual(["request_id"]);
  });

  it("blocks an authorization token after the certificate is revoked", async () => {
    const pdf = Buffer.from("%PDF-1.7\nrevocation race certificate\n%%EOF", "ascii");
    const certificate = await createAvailableCertificate("Revocation", pdf);
    const authorization = await request(app.server).post("/api/public/certificates/download-authorize")
      .send({ token: verificationTokenFor(certificate.publicIdentifier) });
    expect(authorization.status).toBe(200);
    await database.updateTable("certificates").set({ status: "REVOKED", revoked_at: new Date(),
      revocation_reason: "Private test reason", updated_at: new Date() }).where("id", "=", certificate.certificateId).execute();
    const response = await request(app.server).post("/api/public/certificates/download")
      .send({ download_token: authorization.body.data.download_token });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("PUBLIC_REQUEST_FAILED");
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.body).not.toEqual(pdf);
  });

  it("rejects an expired token before PostgreSQL and MinIO access without sleeping", async () => {
    const repository = { findByPublicIdentifier: vi.fn() };
    const boundedStorage = { get: vi.fn() };
    const expiredApp = buildApi({ dependencies: { checkDatabase: async () => undefined, checkRedis: async () => undefined },
      readinessTimeoutMs: 1_000, logger: false, publicCertificateDownload: { rateLimiter: limiter("expired"),
        service: new PublicCertificateDownloadService({ verificationKeys, maximumPdfBytes: 1_024,
          now: () => new Date("2026-08-26T10:01:01.000Z"), repository, storage: boundedStorage }) } });
    const expired = createCertificateDownloadToken({ keyId: "active-key", key: activeKey,
      publicIdentifier: "f".repeat(32), issuedAt: authorizationNow, ttlSeconds: 60,
      tokenId: Buffer.alloc(16, 5).toString("base64url") });
    await expiredApp.ready();
    const response = await request(expiredApp.server).post("/api/public/certificates/download")
      .send({ download_token: expired });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("PUBLIC_REQUEST_FAILED");
    expect(repository.findByPublicIdentifier).not.toHaveBeenCalled();
    expect(boundedStorage.get).not.toHaveBeenCalled();
    await expiredApp.close();
  });

  it("blocks corrupted real MinIO bytes when PostgreSQL retains the valid hash", async () => {
    const expectedPdf = Buffer.from("%PDF-1.7\nexpected certificate bytes\n%%EOF", "ascii");
    const corruptedPdf = Buffer.from("%PDF-1.7\nmodified certificate bytes\n%%EOF", "ascii");
    const certificate = await createAvailableCertificate("Corruption", expectedPdf, corruptedPdf);
    const downloadToken = createCertificateDownloadToken({ keyId: "previous-key", key: previousKey,
      publicIdentifier: certificate.publicIdentifier, issuedAt: authorizationNow, ttlSeconds: 60,
      tokenId: Buffer.alloc(16, 6).toString("base64url") });
    const response = await request(app.server).post("/api/public/certificates/download").send({ download_token: downloadToken });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("PUBLIC_REQUEST_FAILED");
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.body).not.toEqual(corruptedPdf);
  });

  it("shares a separate redemption rate-limit bucket across API instances and returns Retry-After", async () => {
    const prefix = `test:phase-six:download-distributed:${randomUUID()}:`;
    const options = { secret: rateLimitSecret, windowSeconds: 60, networkMaximum: 2, keyPrefix: prefix };
    const service = new PublicCertificateDownloadService({ verificationKeys, maximumPdfBytes: 1_024,
      now: () => authorizationNow, storage, repository: { findByPublicIdentifier: (identifier) =>
        findPublicCertificateDownload(database, identifier) } });
    const first = buildApi({ dependencies: { checkDatabase: async () => undefined, checkRedis: async () => undefined },
      readinessTimeoutMs: 1_000, logger: false, publicCertificateDownload: {
        rateLimiter: new PublicVerificationRateLimiter(redisStore, options), service } });
    const second = buildApi({ dependencies: { checkDatabase: async () => undefined, checkRedis: async () => undefined },
      readinessTimeoutMs: 1_000, logger: false, publicCertificateDownload: {
        rateLimiter: new PublicVerificationRateLimiter(redisStore, options), service } });
    await Promise.all([first.ready(), second.ready()]);
    expect((await request(first.server).post("/api/public/certificates/download")
      .send({ download_token: "malformed" })).status).toBe(400);
    expect((await request(second.server).post("/api/public/certificates/download")
      .send({ download_token: "malformed" })).status).toBe(400);
    const limited = await request(first.server).post("/api/public/certificates/download")
      .send({ download_token: "malformed" });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(limited.body.error.code).toBe("PUBLIC_REQUEST_FAILED");
    await Promise.all([first.close(), second.close()]);
  });
});
