import { randomUUID } from "node:crypto";

import { PublicVerificationRateLimiter } from "@certificate-platform/auth";
import { closeDatabase, createDatabase, findPublicCertificateVerification } from "@certificate-platform/database";
import { createCertificateVerificationToken } from "@certificate-platform/domain";
import { closeRedis, connectRedis, createRedisConnection } from "@certificate-platform/queue";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApi } from "../../src/app.js";
import { createAuthRedisStore } from "../../src/infrastructure/auth-redis-store.js";
import { PublicVerificationService } from "../../src/modules/phase-six/public-verification-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const enabled = databaseUrl !== undefined && redisUrl !== undefined
  && new URL(databaseUrl).pathname.toLowerCase().includes("test");

describe.skipIf(!enabled)("public certificate verification integration", () => {
  const database = createDatabase({ connectionString: databaseUrl!, maxConnections: 4 });
  const redis = createRedisConnection({ url: redisUrl!, connectionName: `public-verification-${randomUUID()}` });
  const redisStore = createAuthRedisStore(redis);
  const activeKey = Buffer.alloc(32, 11);
  const previousKey = Buffer.alloc(32, 12);
  const verificationKeys = new Map<string, Uint8Array>([["active-key", activeKey], ["previous-key", previousKey]]);
  const rateLimitSecret = "public-verification-integration-secret-at-least-32-bytes";
  const organizationId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const projectId = randomUUID();
  const trainingId = randomUUID();
  const templateId = randomUUID();
  const templateVersionId = randomUUID();
  const plannedIssuedAt = new Date("2026-08-25T06:30:00.000Z");
  const records = new Map<string, { publicIdentifier: string; certificateNumber: string }>();
  let app: ReturnType<typeof buildApi>;

  const createCertificate = async (name: string, status: "DRAFT" | "GENERATING" | "AVAILABLE" | "REVOKED") => {
    const participantId = randomUUID();
    const certificateId = randomUUID();
    const publicIdentifier = randomUUID().replaceAll("-", "").toLowerCase();
    const certificateNumber = `P6-${status}-${randomUUID()}`;
    await database.insertInto("participants").values({ id: participantId, organization_id: organizationId,
      display_name: `Live ${name}`, external_reference: `private-${randomUUID()}` }).execute();
    await database.insertInto("training_participants").values({ organization_id: organizationId, training_id: trainingId,
      participant_id: participantId, source_import_job_id: null }).execute();
    await database.insertInto("certificates").values({ id: certificateId, public_identifier: publicIdentifier,
      organization_id: organizationId, training_id: trainingId, participant_id: participantId,
      template_version_id: templateVersionId, certificate_number: certificateNumber, verification_key_kid: "active-key" }).execute();
    await database.insertInto("certificate_issuance_snapshots").values({ certificate_id: certificateId,
      organization_id: organizationId, recipient_display_name: `Snapshot ${name}`, project_name: "Snapshot Public Program",
      training_name: "Snapshot Training", training_code: "SNAPSHOT-CODE", issued_at: plannedIssuedAt }).execute();

    if (status !== "DRAFT") {
      await database.updateTable("certificates").set({ status: "GENERATING", updated_at: new Date() })
        .where("id", "=", certificateId).execute();
    }
    if (status === "AVAILABLE" || status === "REVOKED") {
      const jobId = randomUUID();
      await database.insertInto("jobs").values({ id: jobId, organization_id: organizationId,
        job_type: "CERTIFICATE_GENERATION", idempotency_key: `p6-${randomUUID()}`,
        requested_by_membership_id: membershipId }).execute();
      await database.insertInto("certificate_generation_jobs").values({ job_id: jobId, organization_id: organizationId,
        training_id: trainingId, template_version_id: templateVersionId, generation_revision: 1,
        selection_mode: "EXPLICIT", request_fingerprint: Buffer.alloc(32, 6), renderer_revision: "pdfkit-qrcode-v1" }).execute();
      await database.insertInto("certificate_generation_items").values({ organization_id: organizationId, job_id: jobId,
        certificate_id: certificateId, generation_revision: 1, status: "SUCCEEDED" }).execute();
      await database.updateTable("certificates").set({ status: "AVAILABLE", issued_at: plannedIssuedAt,
        pdf_storage_key: `certificates/${certificateId}/1.pdf`, pdf_content_sha256: Buffer.alloc(32, 6),
        pdf_size_bytes: "128", pdf_mime_type: "application/pdf", updated_at: new Date() })
        .where("id", "=", certificateId).execute();
    }
    if (status === "REVOKED") {
      await database.updateTable("certificates").set({ status: "REVOKED", revoked_at: new Date(),
        revocation_reason: "Private revocation reason", updated_at: new Date() }).where("id", "=", certificateId).execute();
    }
    records.set(status, { publicIdentifier, certificateNumber });
    return { publicIdentifier, certificateNumber };
  };

  const tokenFor = (publicIdentifier: string, keyId = "active-key", key = activeKey) =>
    createCertificateVerificationToken({ keyId, key, publicIdentifier, issuedAt: plannedIssuedAt });
  const tamperSignature = (value: string): string => {
    const segments = value.split(".");
    const signature = Buffer.from(segments[2]!, "base64url");
    signature[0] = signature[0]! ^ 0x01;
    return `${segments[0]}.${segments[1]}.${signature.toString("base64url")}`;
  };
  const genericError = (requestId: unknown) => ({ error: { code: "PUBLIC_REQUEST_FAILED",
    message: "The request could not be completed." }, meta: { request_id: requestId } });
  const createApp = (rateLimiter: PublicVerificationRateLimiter) => buildApi({
    dependencies: { checkDatabase: async () => undefined, checkRedis: async () => undefined },
    readinessTimeoutMs: 1_000,
    logger: false,
    publicVerification: {
      rateLimiter,
      service: new PublicVerificationService({ verificationKeys,
        repository: { findByPublicIdentifier: (identifier) => findPublicCertificateVerification(database, identifier) } })
    }
  });

  beforeAll(async () => {
    await connectRedis(redis);
    await database.insertInto("users").values({ id: userId, email: `phase6-${randomUUID()}@example.invalid`, password_hash: "synthetic" }).execute();
    await database.insertInto("organizations").values({ id: organizationId, name: "Phase Six Verification Tenant" }).execute();
    await database.insertInto("organization_memberships").values({ id: membershipId, organization_id: organizationId, user_id: userId }).execute();
    await database.insertInto("projects").values({ id: projectId, organization_id: organizationId,
      name: "Mutable Live Project", slug: `phase6-${randomUUID()}` }).execute();
    await database.insertInto("trainings").values({ id: trainingId, organization_id: organizationId, project_id: projectId,
      name: "Mutable Live Training", code: `P6-${randomUUID()}` }).execute();
    await database.insertInto("certificate_templates").values({ id: templateId, organization_id: organizationId,
      name: "Phase Six Template" }).execute();
    await database.insertInto("template_versions").values({ id: templateVersionId, organization_id: organizationId,
      template_id: templateId, version: 1, definition_json: { format_version: 1 }, status: "PUBLISHED", published_at: new Date() }).execute();
    await createCertificate("Available Recipient", "AVAILABLE");
    await createCertificate("Revoked Recipient", "REVOKED");
    await createCertificate("Draft Recipient", "DRAFT");
    await createCertificate("Generating Recipient", "GENERATING");
    await database.updateTable("participants").set({ display_name: "Changed Mutable Recipient" })
      .where("organization_id", "=", organizationId).execute();
    await database.updateTable("projects").set({ name: "Changed Mutable Project" }).where("id", "=", projectId).execute();
    await database.updateTable("trainings").set({ name: "Changed Mutable Training" }).where("id", "=", trainingId).execute();
    app = createApp(new PublicVerificationRateLimiter(redisStore, { secret: rateLimitSecret, windowSeconds: 60,
      networkMaximum: 100, keyPrefix: `test:public-verification:${randomUUID()}:` }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await Promise.allSettled([closeDatabase(database), closeRedis(redis)]);
  });

  it("returns only immutable public fields for AVAILABLE and no-cache/noindex headers", async () => {
    const available = records.get("AVAILABLE")!;
    const response = await request(app.server).post("/api/public/verify").send({ token: tokenFor(available.publicIdentifier) });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { status: "valid", certificate_number: available.certificateNumber,
      recipient_name: "Snapshot Available Recipient", program_name: "Snapshot Public Program", issued_at: "2026-08-25" },
    meta: { request_id: expect.any(String) } });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
    expect(response.headers["x-request-id"]).toBe(response.body.meta.request_id);
    expect(JSON.stringify(response.body)).not.toMatch(/public_identifier|organization|participant|external|storage|pdf_|verification|kid/i);
  });

  it("returns only revoked status and certificate number", async () => {
    const revoked = records.get("REVOKED")!;
    const response = await request(app.server).post("/api/public/verify").send({ token: tokenFor(revoked.publicIdentifier) });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { status: "revoked", certificate_number: revoked.certificateNumber },
      meta: { request_id: expect.any(String) } });
    expect(JSON.stringify(response.body)).not.toMatch(/reason|recipient|program|issued/i);
  });

  it("uses one generic public failure for enumeration-resistant cases", async () => {
    const available = records.get("AVAILABLE")!;
    const valid = tokenFor(available.publicIdentifier);
    const cases = [
      "malformed-token",
      tamperSignature(valid),
      tokenFor(available.publicIdentifier, "unknown-key", Buffer.alloc(32, 15)),
      tokenFor("f".repeat(32)),
      tokenFor(records.get("DRAFT")!.publicIdentifier),
      tokenFor(records.get("GENERATING")!.publicIdentifier)
    ];
    for (const token of cases) {
      const response = await request(app.server).post("/api/public/verify").send({ token });
      expect(response.status).toBe(400);
      expect(response.body).toEqual(genericError(expect.any(String)));
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
    }
  });

  it("strictly validates the POST JSON body without authentication or tenant headers", async () => {
    for (const body of [{}, { token: "" }, { token: 1 }, { token: "x", extra: true }, { token: "x".repeat(2_049) }]) {
      const response = await request(app.server).post("/api/public/verify").send(body);
      expect(response.status).toBe(400);
      expect(response.body).toEqual(genericError(expect.any(String)));
    }
    expect((await request(app.server).get(`/api/public/verify?token=${encodeURIComponent(tokenFor(records.get("AVAILABLE")!.publicIdentifier))}`)).status).toBe(404);
  });

  it("shares Redis rate limits across API instances and returns Retry-After", async () => {
    const prefix = `test:public-verification-distributed:${randomUUID()}:`;
    const limiterOptions = { secret: rateLimitSecret, windowSeconds: 60, networkMaximum: 2, keyPrefix: prefix };
    const first = createApp(new PublicVerificationRateLimiter(redisStore, limiterOptions));
    const second = createApp(new PublicVerificationRateLimiter(redisStore, limiterOptions));
    await Promise.all([first.ready(), second.ready()]);
    const token = tokenFor(records.get("AVAILABLE")!.publicIdentifier);
    expect((await request(first.server).post("/api/public/verify").send({ token })).status).toBe(200);
    expect((await request(second.server).post("/api/public/verify").send({ token })).status).toBe(200);
    const limited = await request(first.server).post("/api/public/verify").send({ token });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(limited.body).toEqual(genericError(expect.any(String)));
    expect(JSON.stringify(limited.body)).not.toContain(token);
    await Promise.all([first.close(), second.close()]);
  });
});
