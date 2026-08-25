import { createHash, randomUUID } from "node:crypto";

import type { CertificateRenderInput } from "@certificate-platform/certificate-renderer";
import {
  armStorageCleanup,
  closeDatabase,
  createDatabase,
  planCertificateGeneration,
  publishCertificateGeneration
} from "@certificate-platform/database";
import {
  createPrivateObjectStorage,
  createS3Client,
  ensurePrivateBucket,
  type PrivateObjectStorage,
  type PutPrivateObjectInput
} from "@certificate-platform/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CertificateGenerationProcessor } from "../../src/processors/certificate-generation-processor.js";
import { StorageCleanupReconciler } from "../../src/storage-cleanup-reconciler.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = databaseUrl !== undefined && new URL(databaseUrl).pathname.toLowerCase().includes("test");
const objectStorageEnabled = process.env.OBJECT_STORAGE_ENDPOINT !== undefined
  && process.env.OBJECT_STORAGE_BUCKET !== undefined
  && process.env.OBJECT_STORAGE_ACCESS_KEY !== undefined
  && process.env.OBJECT_STORAGE_SECRET_KEY !== undefined;
const plannedIssuedAt = new Date("2026-08-25T06:00:00.000Z");
const signingKey = new Uint8Array(32).fill(17);
const minimalPdf = new Uint8Array(Buffer.from("%PDF-1.4\n%%EOF"));

class MemoryStorage implements PrivateObjectStorage {
  readonly objects = new Map<string, Uint8Array>();
  readonly inputs: PutPrivateObjectInput[] = [];
  readonly sourceObjects = new Map<string, Uint8Array>();
  failPut = false;

  async put(input: PutPrivateObjectInput): Promise<void> {
    if (this.failPut) throw new Error("synthetic storage outage");
    this.inputs.push({ ...input, body: new Uint8Array(input.body) });
    this.objects.set(input.key, new Uint8Array(input.body));
  }
  async get(key: string, maximumBytes: number): Promise<Uint8Array> {
    const bytes = this.sourceObjects.get(key);
    if (bytes === undefined || bytes.byteLength > maximumBytes) throw new Error("synthetic asset unavailable");
    return new Uint8Array(bytes);
  }
  async delete(key: string): Promise<void> { this.objects.delete(key); }
}

describe.skipIf(!enabled)("certificate generation worker PostgreSQL integration", () => {
  const database = createDatabase({ connectionString: databaseUrl!, maxConnections: 6 });
  const organizationId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const projectId = randomUUID();
  const trainingId = randomUUID();
  const templateId = randomUUID();
  const templateVersionId = randomUUID();
  const assetTemplateId = randomUUID();
  const assetTemplateVersionId = randomUUID();
  const imageAssetId = randomUUID();
  const imageStorageKey = `template-assets/${organizationId}/${imageAssetId}`;
  const imageBytes = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  const basicDefinition = {
    format_version: 1,
    page: { width: 600, height: 400, unit: "px" },
    elements: [
      { type: "text", x: 40, y: 80, width: 520, height: 70, opacity: 1, binding: "recipient.display_name", align: "center", color: "#000000", font: { family: "Noto Sans Thai", size: 28, weight: 400 } },
      { type: "qr", x: 250, y: 220, width: 100, height: 100, opacity: 1, binding: "verification_url", foreground: "#000000", background: "#FFFFFF" }
    ]
  };

  beforeAll(async () => {
    await database.insertInto("organizations").values({ id: organizationId, name: "Generation Worker Tenant" }).execute();
    await database.insertInto("users").values({ id: userId, email: `generation-worker-${randomUUID()}@example.invalid`, password_hash: "synthetic" }).execute();
    await database.insertInto("organization_memberships").values({ id: membershipId, organization_id: organizationId, user_id: userId }).execute();
    await database.insertInto("projects").values({ id: projectId, organization_id: organizationId, name: "Immutable Project", slug: `generation-worker-${randomUUID()}` }).execute();
    await database.insertInto("trainings").values({ id: trainingId, organization_id: organizationId, project_id: projectId, name: "Immutable Training", code: "IMMUTABLE-001" }).execute();
    await database.insertInto("certificate_templates").values([
      { id: templateId, organization_id: organizationId, name: "Worker Template" },
      { id: assetTemplateId, organization_id: organizationId, name: "Worker Asset Template" }
    ]).execute();
    await database.insertInto("template_versions").values([
      { id: templateVersionId, organization_id: organizationId, template_id: templateId, version: 1, definition_json: basicDefinition, status: "PUBLISHED", published_at: plannedIssuedAt },
      { id: assetTemplateVersionId, organization_id: organizationId, template_id: assetTemplateId, version: 1,
        definition_json: { ...basicDefinition, elements: [{ type: "image", x: 10, y: 10, width: 20, height: 20, opacity: 1, asset_id: imageAssetId, fit: "contain" }, ...basicDefinition.elements] } }
    ]).execute();
    await database.insertInto("template_assets").values({ id: imageAssetId, organization_id: organizationId, template_id: assetTemplateId,
      storage_key: imageStorageKey, original_filename: "pixel.png", content_sha256: createHash("sha256").update(imageBytes).digest(),
      detected_mime_type: "image/png", size_bytes: String(imageBytes.byteLength), width_px: 1, height_px: 1,
      created_by_membership_id: membershipId, status: "ACTIVE" }).execute();
    await database.insertInto("template_version_assets").values({ organization_id: organizationId, template_id: assetTemplateId,
      template_version_id: assetTemplateVersionId, asset_id: imageAssetId }).execute();
    await database.updateTable("template_versions").set({ status: "PUBLISHED", published_at: plannedIssuedAt })
      .where("id", "=", assetTemplateVersionId).execute();
  });
  afterAll(async () => closeDatabase(database));

  const plan = async (name: string, selectedTemplateVersionId = templateVersionId) => {
    const participantId = randomUUID();
    await database.insertInto("participants").values({ id: participantId, organization_id: organizationId, display_name: name, external_reference: null }).execute();
    await database.insertInto("training_participants").values({ organization_id: organizationId, training_id: trainingId, participant_id: participantId, source_import_job_id: null }).execute();
    const result = await planCertificateGeneration(database, {
      organizationId, trainingId, templateVersionId: selectedTemplateVersionId, idempotencyKey: `worker-${randomUUID()}`,
      requestedByMembershipId: membershipId, selectionMode: "EXPLICIT", requestedParticipantIds: [participantId],
      rendererRevision: "pdfkit-qrcode-v1", verificationKeyKid: "key-2026-01", plannedIssuedAt
    });
    if (result.kind !== "CREATED") throw new Error(`planning failed: ${result.kind}`);
    const item = await database.selectFrom("certificate_generation_items").select(["id", "certificate_id", "generation_revision"])
      .where("job_id", "=", result.jobId).executeTakeFirstOrThrow();
    return { participantId, jobId: result.jobId, ...item };
  };

  const planMany = async (names: readonly string[]) => {
    const participantIds: string[] = [];
    for (const name of names) {
      const participantId = randomUUID();
      participantIds.push(participantId);
      await database.insertInto("participants").values({ id: participantId, organization_id: organizationId, display_name: name, external_reference: null }).execute();
      await database.insertInto("training_participants").values({ organization_id: organizationId, training_id: trainingId, participant_id: participantId, source_import_job_id: null }).execute();
    }
    const result = await planCertificateGeneration(database, {
      organizationId, trainingId, templateVersionId, idempotencyKey: `worker-many-${randomUUID()}`,
      requestedByMembershipId: membershipId, selectionMode: "EXPLICIT", requestedParticipantIds: participantIds,
      rendererRevision: "pdfkit-qrcode-v1", verificationKeyKid: "key-2026-01", plannedIssuedAt
    });
    if (result.kind !== "CREATED") throw new Error(`planning failed: ${result.kind}`);
    const items = await database.selectFrom("certificate_generation_items").select(["id", "certificate_id", "generation_revision"])
      .where("job_id", "=", result.jobId).orderBy("created_at", "asc").orderBy("id", "asc").execute();
    return { jobId: result.jobId, items };
  };

  const processor = (storage: PrivateObjectStorage, overrides: Partial<ConstructorParameters<typeof CertificateGenerationProcessor>[0]> = {}) =>
    new CertificateGenerationProcessor({ database, storage, verificationBaseUrl: "https://verify.example.invalid",
      verificationKeys: new Map([["key-2026-01", signingKey]]), maximumAssetBytes: 2_000_000, maximumPdfBytes: 2_000_000,
      now: () => plannedIssuedAt, ...overrides });

  it("renders exact assets and publishes valid private PDF integrity metadata", async () => {
    const planned = await plan("Thai Recipient ผู้รับ", assetTemplateVersionId);
    const storage = new MemoryStorage();
    storage.sourceObjects.set(imageStorageKey, imageBytes);
    await processor(storage).process({ version: 1, job_id: planned.jobId, organization_id: organizationId });

    expect(storage.inputs).toHaveLength(1);
    expect(storage.inputs[0]).toMatchObject({ contentType: "application/pdf" });
    expect(storage.inputs[0]?.key).toBe(`certificates/${organizationId}/${planned.certificate_id}/revision-1.pdf`);
    expect(storage.inputs[0]?.body.byteLength).toBeGreaterThan(0);
    expect(Buffer.from(storage.inputs[0]!.body.subarray(0, 5)).toString("ascii")).toBe("%PDF-");
    const certificate = await database.selectFrom("certificates").selectAll().where("id", "=", planned.certificate_id).executeTakeFirstOrThrow();
    expect(certificate.status).toBe("AVAILABLE");
    expect(certificate.issued_at?.toISOString()).toBe(plannedIssuedAt.toISOString());
    expect(certificate.pdf_mime_type).toBe("application/pdf");
    expect(Number(certificate.pdf_size_bytes)).toBe(storage.inputs[0]?.body.byteLength);
    expect(Buffer.from(certificate.pdf_content_sha256!)).toEqual(createHash("sha256").update(storage.inputs[0]!.body).digest());
    expect((await database.selectFrom("certificate_generation_items").select("status").where("id", "=", planned.id).executeTakeFirstOrThrow()).status).toBe("SUCCEEDED");
    expect(await database.selectFrom("jobs").select(["status", "progress_completed"]).where("id", "=", planned.jobId).executeTakeFirstOrThrow()).toEqual({ status: "SUCCEEDED", progress_completed: 1 });
    expect(await database.selectFrom("storage_cleanup_outbox").select("id").where("object_key", "=", storage.inputs[0]!.key).execute()).toHaveLength(0);

    await armStorageCleanup(database, { organizationId, objectKey: storage.inputs[0]!.key, notBefore: new Date("2000-01-01T00:00:00.000Z") });
    expect(await new StorageCleanupReconciler({ database, storage, batchSize: 10, retryDelayMs: 0 }).runOnce())
      .toMatchObject({ protected: 1, deleted: 0, failed: 0 });
    expect(storage.objects.has(storage.inputs[0]!.key)).toBe(true);

    await processor(storage).process({ version: 1, job_id: planned.jobId, organization_id: organizationId });
    expect(storage.inputs).toHaveLength(1);
  });

  it.skipIf(!objectStorageEnabled)("publishes through the real private S3-compatible storage adapter", async () => {
    const planned = await plan("Private Storage Recipient");
    const s3 = createS3Client({ endpoint: process.env.OBJECT_STORAGE_ENDPOINT!, region: process.env.OBJECT_STORAGE_REGION ?? "us-east-1",
      bucket: process.env.OBJECT_STORAGE_BUCKET!, accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY!,
      secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY!, forcePathStyle: process.env.OBJECT_STORAGE_FORCE_PATH_STYLE !== "false" });
    await ensurePrivateBucket(s3, process.env.OBJECT_STORAGE_BUCKET!, process.env.OBJECT_STORAGE_CREATE_BUCKET === "true");
    const storage = createPrivateObjectStorage(s3, process.env.OBJECT_STORAGE_BUCKET!);
    const objectKey = `certificates/${organizationId}/${planned.certificate_id}/revision-1.pdf`;
    try {
      await processor(storage).process({ version: 1, job_id: planned.jobId, organization_id: organizationId });
      const certificate = await database.selectFrom("certificates").select(["status", "pdf_content_sha256", "pdf_size_bytes", "pdf_mime_type"])
        .where("id", "=", planned.certificate_id).executeTakeFirstOrThrow();
      const bytes = await storage.get(objectKey, 2_000_000);
      expect(certificate.status).toBe("AVAILABLE");
      expect(certificate.pdf_mime_type).toBe("application/pdf");
      expect(Number(certificate.pdf_size_bytes)).toBe(bytes.byteLength);
      expect(Buffer.from(certificate.pdf_content_sha256!)).toEqual(createHash("sha256").update(bytes).digest());
    } finally {
      await storage.delete(objectKey).catch(() => undefined);
      s3.destroy();
    }
  });

  it("renders from the immutable snapshot after live identity data changes", async () => {
    const planned = await plan("Snapshot Recipient");
    await database.updateTable("participants").set({ display_name: "Changed Live Recipient" }).where("id", "=", planned.participantId).execute();
    await database.updateTable("projects").set({ name: "Changed Live Project" }).where("id", "=", projectId).execute();
    await database.updateTable("trainings").set({ name: "Changed Live Training", code: "CHANGED" }).where("id", "=", trainingId).execute();
    let captured: CertificateRenderInput | undefined;
    const render = async (input: unknown): Promise<Uint8Array> => { captured = input as CertificateRenderInput; return minimalPdf; };
    await processor(new MemoryStorage(), { render }).process({ version: 1, job_id: planned.jobId, organization_id: organizationId });
    expect(captured?.bindings).toMatchObject({ recipient: { displayName: "Snapshot Recipient" }, project: { name: "Immutable Project" },
      training: { name: "Immutable Training", code: "IMMUTABLE-001" } });
    await database.updateTable("projects").set({ name: "Immutable Project" }).where("id", "=", projectId).execute();
    await database.updateTable("trainings").set({ name: "Immutable Training", code: "IMMUTABLE-001" }).where("id", "=", trainingId).execute();
  });

  it("keeps storage failures retryable and does not publish before recovery", async () => {
    const planned = await plan("Retry Recipient");
    const storage = new MemoryStorage();
    storage.failPut = true;
    await expect(processor(storage).process({ version: 1, job_id: planned.jobId, organization_id: organizationId })).rejects.toThrow("synthetic storage outage");
    expect(await database.selectFrom("certificates").select(["status", "pdf_storage_key"]).where("id", "=", planned.certificate_id).executeTakeFirstOrThrow())
      .toEqual({ status: "GENERATING", pdf_storage_key: null });
    expect((await database.selectFrom("certificate_generation_items").select("status").where("id", "=", planned.id).executeTakeFirstOrThrow()).status).toBe("FAILED");
    expect(await database.selectFrom("storage_cleanup_outbox").select("id").where("object_key", "=", `certificates/${organizationId}/${planned.certificate_id}/revision-1.pdf`).execute()).toHaveLength(1);
    storage.failPut = false;
    await processor(storage).process({ version: 1, job_id: planned.jobId, organization_id: organizationId });
    expect((await database.selectFrom("certificates").select("status").where("id", "=", planned.certificate_id).executeTakeFirstOrThrow()).status).toBe("AVAILABLE");
  });

  it("rejects changed template asset bytes without publishing", async () => {
    const planned = await plan("Invalid Asset Recipient", assetTemplateVersionId);
    const storage = new MemoryStorage();
    storage.sourceObjects.set(imageStorageKey, new Uint8Array(imageBytes).fill(3));
    await expect(processor(storage).process({ version: 1, job_id: planned.jobId, organization_id: organizationId }))
      .rejects.toMatchObject({ code: "CERTIFICATE_GENERATION_JOB_INVALID" });
    expect(await database.selectFrom("certificates").select(["status", "pdf_storage_key"]).where("id", "=", planned.certificate_id).executeTakeFirstOrThrow())
      .toEqual({ status: "GENERATING", pdf_storage_key: null });
    expect(storage.inputs).toHaveLength(0);
  });

  it("leaves uploaded objects on the durable cleanup path when publication fails", async () => {
    const planned = await plan("Cleanup Recipient");
    const storage = new MemoryStorage();
    const publish = async (): Promise<"PUBLISHED"> => { throw new Error("synthetic database publication failure"); };
    await expect(processor(storage, { publish, cleanupDelayMs: 0 }).process({ version: 1, job_id: planned.jobId, organization_id: organizationId }))
      .rejects.toThrow("synthetic database publication failure");
    const objectKey = `certificates/${organizationId}/${planned.certificate_id}/revision-1.pdf`;
    expect(storage.objects.has(objectKey)).toBe(true);
    expect(await database.selectFrom("storage_cleanup_outbox").select("id").where("object_key", "=", objectKey).execute()).toHaveLength(1);
    const reconciler = new StorageCleanupReconciler({ database, storage, batchSize: 10, retryDelayMs: 0 });
    expect((await reconciler.runOnce(new Date(plannedIssuedAt.getTime() + 1))).deleted).toBeGreaterThanOrEqual(1);
    expect(storage.objects.has(objectKey)).toBe(false);
  });

  it("rejects a duplicate stale publication without replacing current PDF metadata", async () => {
    const planned = await plan("Stale Recipient");
    const storage = new MemoryStorage();
    await processor(storage, { render: async () => minimalPdf }).process({ version: 1, job_id: planned.jobId, organization_id: organizationId });
    const newerJobId = randomUUID();
    await database.insertInto("jobs").values({ id: newerJobId, organization_id: organizationId, job_type: "CERTIFICATE_GENERATION",
      idempotency_key: `newer-${newerJobId}`, requested_by_membership_id: membershipId }).execute();
    await database.insertInto("certificate_generation_jobs").values({ job_id: newerJobId, organization_id: organizationId,
      training_id: trainingId, template_version_id: templateVersionId, generation_revision: 2, selection_mode: "EXPLICIT",
      request_fingerprint: new Uint8Array(32).fill(4), renderer_revision: "pdfkit-qrcode-v1" }).execute();
    await database.insertInto("certificate_generation_items").values({ organization_id: organizationId, job_id: newerJobId,
      certificate_id: planned.certificate_id, generation_revision: 2, status: "SUCCEEDED" }).execute();
    await database.updateTable("certificates").set({ generation_revision: 2,
      pdf_storage_key: `certificates/${organizationId}/${planned.certificate_id}/revision-2.pdf`,
      pdf_content_sha256: new Uint8Array(32).fill(8), pdf_size_bytes: "88", pdf_mime_type: "application/pdf" })
      .where("id", "=", planned.certificate_id).execute();
    const current = await database.selectFrom("certificates").select(["generation_revision", "pdf_storage_key", "pdf_content_sha256", "pdf_size_bytes"])
      .where("id", "=", planned.certificate_id).executeTakeFirstOrThrow();
    await expect(publishCertificateGeneration(database, { organizationId, jobId: planned.jobId, itemId: planned.id,
      certificateId: planned.certificate_id, generationRevision: planned.generation_revision,
      objectKey: `${current.pdf_storage_key}-stale`, contentSha256: new Uint8Array(32).fill(9), sizeBytes: 99, mimeType: "application/pdf" }))
      .rejects.toMatchObject({ code: "CERTIFICATE_GENERATION_STALE_REVISION" });
    expect(await database.selectFrom("certificates").select(["generation_revision", "pdf_storage_key", "pdf_content_sha256", "pdf_size_bytes"])
      .where("id", "=", planned.certificate_id).executeTakeFirstOrThrow()).toEqual(current);
  });

  it("dead-letters remaining durable work after final BullMQ exhaustion", async () => {
    const planned = await plan("Dead Letter Recipient");
    await processor(new MemoryStorage()).handleFinalFailure({ version: 1, job_id: planned.jobId, organization_id: organizationId });
    expect((await database.selectFrom("jobs").select("status").where("id", "=", planned.jobId).executeTakeFirstOrThrow()).status).toBe("DEAD_LETTER");
    expect((await database.selectFrom("certificate_generation_items").select("status").where("id", "=", planned.id).executeTakeFirstOrThrow()).status).toBe("DEAD_LETTER");
    expect((await database.selectFrom("certificates").select("status").where("id", "=", planned.certificate_id).executeTakeFirstOrThrow()).status).toBe("DRAFT");
  });

  it("recovers a multi-item job without double-counting an already published item", async () => {
    const planned = await planMany(["Multi Item A", "Multi Item B"]);
    const storage = new MemoryStorage();
    let renderCount = 0;
    let failSecond = true;
    const render = async (): Promise<Uint8Array> => {
      renderCount += 1;
      if (renderCount === 2 && failSecond) throw new Error("synthetic transient renderer failure");
      return minimalPdf;
    };
    const generationProcessor = processor(storage, { render });
    await expect(generationProcessor.process({ version: 1, job_id: planned.jobId, organization_id: organizationId }))
      .rejects.toThrow("synthetic transient renderer failure");
    expect(await database.selectFrom("jobs").select(["status", "progress_total", "progress_completed"])
      .where("id", "=", planned.jobId).executeTakeFirstOrThrow()).toEqual({ status: "RUNNING", progress_total: 2, progress_completed: 1 });
    expect((await database.selectFrom("certificate_generation_items").select("status").where("job_id", "=", planned.jobId).execute())
      .map((item) => item.status).sort()).toEqual(["FAILED", "SUCCEEDED"]);

    failSecond = false;
    await generationProcessor.process({ version: 1, job_id: planned.jobId, organization_id: organizationId });
    expect(renderCount).toBe(3);
    expect(await database.selectFrom("jobs").select(["status", "progress_total", "progress_completed"])
      .where("id", "=", planned.jobId).executeTakeFirstOrThrow()).toEqual({ status: "SUCCEEDED", progress_total: 2, progress_completed: 2 });
    expect((await database.selectFrom("certificates").select("status").where("id", "in", planned.items.map((item) => item.certificate_id)).execute())
      .map((certificate) => certificate.status)).toEqual(["AVAILABLE", "AVAILABLE"]);

    await generationProcessor.process({ version: 1, job_id: planned.jobId, organization_id: organizationId });
    expect(renderCount).toBe(3);
    expect((await database.selectFrom("certificate_generation_items").select("status").where("job_id", "=", planned.jobId).execute())
      .map((item) => item.status)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
  });

  it("does not resurrect a revoked certificate on delayed duplicate execution", async () => {
    const planned = await plan("Revoked Recipient");
    const storage = new MemoryStorage();
    await processor(storage, { render: async () => minimalPdf }).process({ version: 1, job_id: planned.jobId, organization_id: organizationId });
    const published = await database.selectFrom("certificates").selectAll().where("id", "=", planned.certificate_id).executeTakeFirstOrThrow();
    await database.updateTable("certificates").set({
      status: "REVOKED",
      revoked_at: new Date("2026-08-25T09:00:00.000Z"),
      revocation_reason: "Synthetic terminal revocation"
    }).where("id", "=", planned.certificate_id).execute();

    await processor(storage, { render: async () => { throw new Error("renderer must not run"); } })
      .process({ version: 1, job_id: planned.jobId, organization_id: organizationId });
    expect(await database.selectFrom("certificates").select([
      "status", "generation_revision", "pdf_storage_key", "pdf_content_sha256", "pdf_size_bytes", "pdf_mime_type", "issued_at"
    ]).where("id", "=", planned.certificate_id).executeTakeFirstOrThrow()).toEqual({
      status: "REVOKED",
      generation_revision: published.generation_revision,
      pdf_storage_key: published.pdf_storage_key,
      pdf_content_sha256: published.pdf_content_sha256,
      pdf_size_bytes: published.pdf_size_bytes,
      pdf_mime_type: published.pdf_mime_type,
      issued_at: published.issued_at
    });
  });
});
