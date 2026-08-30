import { createHash, randomUUID } from "node:crypto";

import { PublicVerificationRateLimiter } from "@certificate-platform/auth";
import { closeDatabase, createDatabase, findPublicCertificateDownload,
  findPublicCertificateDownloadAuthorization, findPublicCertificateVerification,
  findPublicCertificatesBySearch, suggestPublicCertificateProjects,
  suggestPublicCertificateTrainings } from "@certificate-platform/database";
import { createCertificateDownloadToken, createCertificateVerificationToken } from "@certificate-platform/domain";
import { closeRedis, connectRedis, createRedisConnection } from "@certificate-platform/queue";
import { createPrivateObjectStorage, createS3Client, ensurePrivateBucket } from "@certificate-platform/storage";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApi } from "../../src/app.js";
import { createAuthRedisStore } from "../../src/infrastructure/auth-redis-store.js";
import { PublicCertificateDownloadService } from "../../src/modules/phase-six/public-certificate-download-service.js";
import { PublicCertificateSearchService } from "../../src/modules/phase-six/public-certificate-search-service.js";
import { PublicSearchDownloadAuthorizationService } from "../../src/modules/phase-six/public-search-download-authorization-service.js";
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
  const contextSuffix = randomUUID().slice(0, 8);
  const snapshotProjectName = `Phase Six ${contextSuffix} Program`;
  const snapshotTrainingName = `Phase Six ${contextSuffix} Training`;
  const userId = randomUUID();
  const membershipId = randomUUID();
  const projectId = randomUUID();
  const trainingId = randomUUID();
  const templateId = randomUUID();
  const templateVersionId = randomUUID();
  const objectKeys: string[] = [];
  let app: ReturnType<typeof buildApi>;

  const createAvailableCertificate = async (label: string, expectedPdf: Uint8Array, storedPdf = expectedPdf,
    recipientDisplayName = `Snapshot ${label}`) => {
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
      organization_id: organizationId, recipient_display_name: recipientDisplayName, project_name: snapshotProjectName,
      training_name: snapshotTrainingName, training_code: "P6", issued_at: plannedIssuedAt }).execute();
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
    , publicCertificateSearch: { rateLimiter: limiter("search"),
      projectSuggestionRateLimiter: limiter("project-suggestion"),
      trainingSuggestionRateLimiter: limiter("training-suggestion"),
      service: new PublicCertificateSearchService({ activeSigningKeyId: "active-key", activeSigningKey: activeKey,
        ttlSeconds: 180, now, repository: { search: (criteria, limit) =>
          findPublicCertificatesBySearch(database, criteria, limit),
        suggestProjects: (query, limit) => suggestPublicCertificateProjects(database, query, limit),
        suggestTrainings: (projectName, query, limit) =>
          suggestPublicCertificateTrainings(database, projectName, query, limit) } }) },
    publicSearchDownloadAuthorization: { rateLimiter: limiter("search-authorize"),
      service: new PublicSearchDownloadAuthorizationService({ verificationKeys, activeSigningKeyId: "active-key",
        activeSigningKey: activeKey, downloadTtlSeconds: 60, now,
        repository: { findByPublicIdentifier: (identifier) =>
          findPublicCertificateDownloadAuthorization(database, identifier) } }) }
  });

  beforeAll(async () => {
    await connectRedis(redis);
    await ensurePrivateBucket(s3, storageConfiguration.bucket!, true);
    await database.insertInto("users").values({ id: userId,
      email: `phase-six-download-${randomUUID()}@example.invalid`, password_hash: "synthetic" }).execute();
    await database.insertInto("organizations").values({ id: organizationId, name: "Phase Six Download Tenant" }).execute();
    await database.updateTable("organizations").set({ public_certificate_search_enabled: true })
      .where("id", "=", organizationId).execute();
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

  it("proves Thai bounded search -> distinct result capability -> current-state authorization -> canonical PDF redemption", async () => {
    const pdf = Buffer.from("%PDF-1.7\nsearch-discovered private certificate\n%%EOF", "ascii");
    const certificate = await createAvailableCertificate("ค้นหาภาษาไทย", pdf);
    await database.updateTable("organizations").set({ public_certificate_search_enabled: false })
      .where("id", "=", organizationId).execute();
    const optedOut = await request(app.server).post("/api/public/certificates/search").send({
      recipient_name: "Snapshot ค้นหาภาษาไทย", project_name: snapshotProjectName
    });
    expect(optedOut.body.data.results).toEqual([]);
    await database.updateTable("organizations").set({ public_certificate_search_enabled: true })
      .where("id", "=", organizationId).execute();
    const trainingOnly = await request(app.server).post("/api/public/certificates/search").send({
      recipient_name: "Snapshot ค้นหาภาษาไทย", training_name: snapshotTrainingName
    });
    expect(trainingOnly.status).toBe(200);
    expect(trainingOnly.body.data.results).toHaveLength(1);
    const searched = await request(app.server).post("/api/public/certificates/search").send({
      recipient_name: "Snapshot ค้นหาภาษาไทย", project_name: snapshotProjectName,
      training_name: snapshotTrainingName
    });
    expect(searched.status).toBe(200);
    expect(searched.body.data.too_broad).toBe(false);
    expect(searched.body.data.results).toHaveLength(1);
    expect(searched.body.data.results[0]).toMatchObject({ recipient_name: "Snapshot ค้นหาภาษาไทย",
      project_name: snapshotProjectName, training_name: snapshotTrainingName, status: "available" });
    expect(JSON.stringify(searched.body)).not.toMatch(/public_identifier|certificate_id|participant|storage|sha|kid|jti/i);
    const searchToken = searched.body.data.results[0].search_result_token as string;
    expect(searchToken).not.toContain(certificate.publicIdentifier);

    const authorization = await request(app.server).post("/api/public/certificates/search-download-authorize")
      .send({ search_result_token: searchToken });
    expect(authorization.status).toBe(200);
    const downloaded = await request(app.server).post("/api/public/certificates/download")
      .send({ download_token: authorization.body.data.download_token });
    expect(downloaded.status).toBe(200);
    expect(downloaded.body).toEqual(pdf);
  });

  it("matches only complete canonical Thai recipient names across allowlisted leading titles", async () => {
    const createNamedCertificate = async (recipientName: string) => {
      const pdf = Buffer.from("%PDF-1.7\ncanonical recipient title\n%%EOF", "ascii");
      return createAvailableCertificate(`title-${randomUUID()}`, pdf, pdf, recipientName);
    };
    await createNamedCertificate("เด็กชายณัฐกิตต์ ไพนิตย์");
    await createNamedCertificate("เด็กหญิงปุณณดา ทดสอบ");
    await createNamedCertificate("นางสาวกมลชนก ตัวอย่าง");
    await createNamedCertificate("นายวิทยา แบบทดสอบ");
    await createNamedCertificate("นางอรุณี สาธิต");

    const search = async (recipientName: string, context: "project" | "training" = "project") =>
      request(app.server).post("/api/public/certificates/search").send({
        recipient_name: recipientName,
        ...(context === "project" ? { project_name: snapshotProjectName } : { training_name: snapshotTrainingName })
      });

    const withoutTitleByProject = await search("ณัฐกิตต์ ไพนิตย์");
    expect(withoutTitleByProject.status).toBe(200);
    expect(withoutTitleByProject.body.data.results).toHaveLength(1);
    expect(withoutTitleByProject.body.data.results[0].recipient_name).toBe("เด็กชายณัฐกิตต์ ไพนิตย์");

    const fullStoredName = await search("เด็กชายณัฐกิตต์ ไพนิตย์");
    expect(fullStoredName.body.data.results).toHaveLength(1);
    const abbreviatedWithCanonicalUnicode = await search("ด．ช．\u3000ณัฐกิตต์   ไพนิตย์");
    expect(abbreviatedWithCanonicalUnicode.body.data.results).toHaveLength(1);
    const differentTitle = await search("นางณัฐกิตต์ ไพนิตย์");
    expect(differentTitle.body.data).toEqual({ results: [], too_broad: false });
    const withoutTitleByTraining = await search("ณัฐกิตต์ ไพนิตย์", "training");
    expect(withoutTitleByTraining.body.data.results).toHaveLength(1);

    for (const [storedTitle, query] of [
      ["เด็กหญิง", "ด.ญ. ปุณณดา ทดสอบ"],
      ["นางสาว", "กมลชนก ตัวอย่าง"],
      ["นาย", "วิทยา แบบทดสอบ"],
      ["นาง", "อรุณี สาธิต"]
    ] as const) {
      const response = await search(query);
      expect(response.body.data.results).toHaveLength(1);
      expect(response.body.data.results[0].recipient_name).toMatch(new RegExp(`^${storedTitle}`));
    }

    for (const partialName of ["ณัฐกิตต์", "ไพนิตย์"]) {
      const response = await search(partialName);
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ results: [], too_broad: false });
    }
    const tooShortPartial = await search("ณัฐ");
    expect(tooShortPartial.status).toBe(400);
    expect(tooShortPartial.body.error.code).toBe("PUBLIC_REQUEST_FAILED");

    const missingContext = await request(app.server).post("/api/public/certificates/search")
      .send({ recipient_name: "ณัฐกิตต์ ไพนิตย์" });
    expect(missingContext.status).toBe(400);
    expect(missingContext.body.error.code).toBe("PUBLIC_REQUEST_FAILED");
  });

  it("suggests only opted-in AVAILABLE snapshot contexts with Thai/Unicode prefix normalization", async () => {
    await createAvailableCertificate("ตัวอย่างคำค้น", Buffer.from("%PDF-1.7\nsuggestion\n%%EOF", "ascii"));
    const project = await request(app.server).post("/api/public/certificates/project-suggestions")
      .send({ query: `  phase\u3000six ${contextSuffix} ` });
    expect(project.status).toBe(200);
    expect(project.body.data.suggestions).toEqual([{ label: snapshotProjectName }]);
    expect(JSON.stringify(project.body)).not.toMatch(/organization_id|participant|recipient|public_identifier|external_reference|count|total/i);
    const independentTraining = await request(app.server).post("/api/public/certificates/training-suggestions")
      .send({ query: `phase\u3000six ${contextSuffix}` });
    expect(independentTraining.status).toBe(200);
    expect(independentTraining.body.data.suggestions).toEqual([{ label: snapshotTrainingName }]);
    const training = await request(app.server).post("/api/public/certificates/training-suggestions")
      .send({ query: `phase\u3000six ${contextSuffix}`, project_name: ` phase   six ${contextSuffix} program ` });
    expect(training.status).toBe(200);
    expect(training.body.data.suggestions).toEqual([{ label: snapshotTrainingName }]);
    const wrongProject = await request(app.server).post("/api/public/certificates/training-suggestions")
      .send({ query: `phase six ${contextSuffix}`, project_name: "Different project" });
    expect(wrongProject.body.data.suggestions).toEqual([]);

    await database.updateTable("organizations").set({ public_certificate_search_enabled: false })
      .where("id", "=", organizationId).execute();
    const [disabledProject, disabledTraining] = await Promise.all([
      request(app.server).post("/api/public/certificates/project-suggestions")
        .send({ query: `Phase Six ${contextSuffix}` }),
      request(app.server).post("/api/public/certificates/training-suggestions")
        .send({ query: `Phase Six ${contextSuffix}` })
    ]);
    expect(disabledProject.body.data.suggestions).toEqual([]);
    expect(disabledTraining.body.data.suggestions).toEqual([]);
    await database.updateTable("organizations").set({ public_certificate_search_enabled: true })
      .where("id", "=", organizationId).execute();
  });

  it("does not suggest a context backed only by a non-AVAILABLE certificate", async () => {
    const participantId = randomUUID();
    const certificateId = randomUUID();
    await database.insertInto("participants").values({ id: participantId, organization_id: organizationId,
      display_name: "Never suggested participant" }).execute();
    await database.insertInto("training_participants").values({ organization_id: organizationId,
      training_id: trainingId, participant_id: participantId }).execute();
    await database.insertInto("certificates").values({ id: certificateId, organization_id: organizationId,
      training_id: trainingId, participant_id: participantId, template_version_id: templateVersionId,
      certificate_number: `DRAFT-${randomUUID()}`, verification_key_kid: "active-key" }).execute();
    await database.insertInto("certificate_issuance_snapshots").values({ certificate_id: certificateId,
      organization_id: organizationId, recipient_display_name: "Private Draft Person",
      project_name: "Draft Only Context", training_name: "Draft Only Training", training_code: "DRAFT",
      issued_at: plannedIssuedAt }).execute();
    const [projectResponse, trainingResponse] = await Promise.all([
      request(app.server).post("/api/public/certificates/project-suggestions").send({ query: "Draft" }),
      request(app.server).post("/api/public/certificates/training-suggestions").send({ query: "Draft" })
    ]);
    expect(projectResponse.status).toBe(200);
    expect(trainingResponse.status).toBe(200);
    expect(projectResponse.body.data.suggestions).toEqual([]);
    expect(trainingResponse.body.data.suggestions).toEqual([]);
    expect(JSON.stringify({ project: projectResponse.body, training: trainingResponse.body }))
      .not.toContain("Private Draft Person");
  });

  it("denies search-result authorization when AVAILABLE changes to REVOKED after search", async () => {
    const certificate = await createAvailableCertificate("Search Revoked Race",
      Buffer.from("%PDF-1.7\nsearch revocation race\n%%EOF", "ascii"));
    const searched = await request(app.server).post("/api/public/certificates/search")
      .send({ certificate_number: (await database.selectFrom("certificates").select("certificate_number")
        .where("id", "=", certificate.certificateId).executeTakeFirstOrThrow()).certificate_number });
    expect(searched.status).toBe(200);
    await database.updateTable("certificates").set({ status: "REVOKED", revoked_at: new Date(),
      revocation_reason: "Private search race reason", updated_at: new Date() })
      .where("id", "=", certificate.certificateId).execute();
    const authorization = await request(app.server).post("/api/public/certificates/search-download-authorize")
      .send({ search_result_token: searched.body.data.results[0].search_result_token });
    expect(authorization.status).toBe(400);
    expect(authorization.body.error.code).toBe("PUBLIC_REQUEST_FAILED");
    const repeatedSearch = await request(app.server).post("/api/public/certificates/search")
      .send({ certificate_number: searched.body.data.results[0].certificate_number });
    expect(repeatedSearch.body.data.results).toEqual([]);
  });

  it("does not enumerate a non-public DRAFT lifecycle row", async () => {
    const participantId = randomUUID();
    const certificateId = randomUUID();
    const certificateNumber = `DRAFT-${randomUUID()}`;
    await database.insertInto("participants").values({ id: participantId, organization_id: organizationId,
      display_name: "Draft Search Person", external_reference: "must-never-be-searchable" }).execute();
    await database.insertInto("training_participants").values({ organization_id: organizationId,
      training_id: trainingId, participant_id: participantId, source_import_job_id: null }).execute();
    await database.insertInto("certificates").values({ id: certificateId,
      public_identifier: randomUUID().replaceAll("-", ""), organization_id: organizationId,
      training_id: trainingId, participant_id: participantId, template_version_id: templateVersionId,
      certificate_number: certificateNumber, verification_key_kid: "active-key" }).execute();
    await database.insertInto("certificate_issuance_snapshots").values({ certificate_id: certificateId,
      organization_id: organizationId, recipient_display_name: "Draft Search Person",
      project_name: snapshotProjectName, training_name: snapshotTrainingName, training_code: "P6",
      issued_at: plannedIssuedAt }).execute();
    const response = await request(app.server).post("/api/public/certificates/search")
      .send({ certificate_number: certificateNumber });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ results: [], too_broad: false });
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
