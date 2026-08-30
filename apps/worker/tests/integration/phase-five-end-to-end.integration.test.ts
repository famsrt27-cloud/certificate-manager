import { createHash, randomUUID } from "node:crypto";

import { renderCertificatePdf, type CertificateRenderInput } from "@certificate-platform/certificate-renderer";
import { closeDatabase, createDatabase, insertAuditRecord } from "@certificate-platform/database";
import type { EffectiveIdentity } from "@certificate-platform/domain";
import {
  closeRedis,
  connectRedis,
  createBullMqRedisConnection,
  createCertificateGenerationProducer,
  createCertificateGenerationWorker
} from "@certificate-platform/queue";
import {
  createPrivateObjectStorage,
  createS3Client,
  ensurePrivateBucket,
  type PrivateObjectStorage
} from "@certificate-platform/storage";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApi } from "../../../api/src/app.js";
import { ApplicationError } from "../../../api/src/errors/application-error.js";
import { OrganizationAuthorizationService } from "../../../api/src/modules/auth/organization-authorization-service.js";
import type { AuthenticatedContext, AuthenticationService } from "../../../api/src/modules/auth/authentication-service.js";
import { PhaseFiveService } from "../../../api/src/modules/phase-five/phase-five-service.js";
import { CertificateGenerationProcessor } from "../../src/processors/certificate-generation-processor.js";
import { QueueOutboxDispatcher } from "../../src/queue-outbox-dispatcher.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const enabled = databaseUrl !== undefined
  && new URL(databaseUrl).pathname.toLowerCase().includes("test")
  && redisUrl !== undefined;
const objectStorageEnabled = process.env.OBJECT_STORAGE_ENDPOINT !== undefined
  && process.env.OBJECT_STORAGE_BUCKET !== undefined
  && process.env.OBJECT_STORAGE_ACCESS_KEY !== undefined
  && process.env.OBJECT_STORAGE_SECRET_KEY !== undefined;
const plannedIssuedAt = new Date("2026-08-25T08:30:00.000Z");
const verificationKey = new Uint8Array(32).fill(29);

class MemoryStorage implements PrivateObjectStorage {
  readonly objects = new Map<string, Uint8Array>();

  async put(input: { readonly key: string; readonly body: Uint8Array }): Promise<void> {
    this.objects.set(input.key, new Uint8Array(input.body));
  }

  async get(key: string, maximumBytes: number): Promise<Uint8Array> {
    const bytes = this.objects.get(key);
    if (bytes === undefined || bytes.byteLength > maximumBytes) throw new Error("object unavailable");
    return new Uint8Array(bytes);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

describe.skipIf(!enabled)("Phase Five API to private storage end-to-end integration", () => {
  const database = createDatabase({ connectionString: databaseUrl!, maxConnections: 6 });
  const organizationId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const projectId = randomUUID();
  const trainingId = randomUUID();
  const templateId = randomUUID();
  const templateVersionId = randomUUID();
  const participantId = randomUUID();
  const csrfToken = "e".repeat(43);
  const queuePrefix = `phase-five-e2e-${randomUUID()}`;
  const objectKeys: string[] = [];
  let app: ReturnType<typeof buildApi>;
  let producerRedis: ReturnType<typeof createBullMqRedisConnection>;
  let workerRedis: ReturnType<typeof createBullMqRedisConnection>;
  let producer: ReturnType<typeof createCertificateGenerationProducer>;
  let queueWorker: ReturnType<typeof createCertificateGenerationWorker>;
  let storage: PrivateObjectStorage;
  let s3: ReturnType<typeof createS3Client> | undefined;
  let capturedRenderInput: CertificateRenderInput | undefined;

  beforeAll(async () => {
    await database.insertInto("users").values({
      id: userId,
      email: `phase-five-e2e-${randomUUID()}@example.invalid`,
      password_hash: "synthetic"
    }).execute();
    await database.insertInto("organizations").values({ id: organizationId, name: "Phase Five E2E Tenant" }).execute();
    await database.insertInto("organization_memberships").values({
      id: membershipId,
      organization_id: organizationId,
      user_id: userId
    }).execute();
    await database.insertInto("projects").values({
      id: projectId,
      organization_id: organizationId,
      name: "Snapshot Project",
      slug: `phase-five-e2e-${randomUUID()}`
    }).execute();
    await database.insertInto("trainings").values({
      id: trainingId,
      organization_id: organizationId,
      project_id: projectId,
      name: "Snapshot Training",
      code: "P5-E2E"
    }).execute();
    await database.insertInto("participants").values({
      id: participantId,
      organization_id: organizationId,
      display_name: "Snapshot Recipient",
      external_reference: null
    }).execute();
    await database.insertInto("training_participants").values({
      organization_id: organizationId,
      training_id: trainingId,
      participant_id: participantId,
      source_import_job_id: null
    }).execute();
    await database.insertInto("certificate_templates").values({
      id: templateId,
      organization_id: organizationId,
      name: "Phase Five E2E Template"
    }).execute();
    await database.insertInto("template_versions").values({
      id: templateVersionId,
      organization_id: organizationId,
      template_id: templateId,
      version: 1,
      definition_json: {
        format_version: 1,
        page: { width: 600, height: 400, unit: "px" },
        elements: [
          { type: "text", x: 40, y: 80, width: 520, height: 70, opacity: 1, binding: "recipient.display_name", align: "center", color: "#000000", font: { family: "Noto Sans Thai", size: 28, weight: 400 } },
          { type: "qr", x: 250, y: 220, width: 100, height: 100, opacity: 1, binding: "verification_url", foreground: "#000000", background: "#FFFFFF" }
        ]
      },
      status: "PUBLISHED",
      published_at: plannedIssuedAt
    }).execute();

    const identity: EffectiveIdentity = {
      user: { id: userId, email: "phase-five-e2e@example.invalid" },
      systemRoles: [],
      memberships: [{
        id: membershipId,
        organizationId,
        organizationName: "Phase Five E2E Tenant",
        roles: ["ORG_ADMIN"],
        permissions: ["certificate:generate"]
      }]
    };
    const authenticated: AuthenticatedContext = {
      sessionId: "s".repeat(43),
      session: {
        version: 1,
        userId,
        csrfToken,
        authorizationVersion: "a".repeat(64),
        createdAt: 1,
        lastSeenAt: 1,
        absoluteExpiresAt: 2
      },
      identity
    };
    const authentication = {
      authenticate: async () => authenticated,
      validateStateChangingRequest: (_context: AuthenticatedContext, origin?: string, csrf?: string) => {
        if (origin !== "https://admin.example.invalid" || csrf !== csrfToken) {
          throw new ApplicationError("REQUEST_FORBIDDEN", "The request could not be authorized.", 403);
        }
      }
    } as unknown as AuthenticationService;
    const authorization = new OrganizationAuthorizationService(authentication, {
      write: (event) => insertAuditRecord(database, event)
    });
    app = buildApi({
      dependencies: { checkDatabase: async () => undefined, checkRedis: async () => undefined },
      readinessTimeoutMs: 1_000,
      logger: false,
      phaseFive: {
        authentication,
        authorization,
        service: new PhaseFiveService({
          database,
          verificationKeyKid: "key-2026-01",
          cursorSecret: "synthetic-phase-five-end-to-end-cursor-secret",
          now: () => plannedIssuedAt
        })
      }
    });
    await app.ready();

    if (objectStorageEnabled) {
      s3 = createS3Client({
        endpoint: process.env.OBJECT_STORAGE_ENDPOINT!,
        region: process.env.OBJECT_STORAGE_REGION ?? "us-east-1",
        bucket: process.env.OBJECT_STORAGE_BUCKET!,
        accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY!,
        secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY!,
        forcePathStyle: process.env.OBJECT_STORAGE_FORCE_PATH_STYLE !== "false"
      });
      await ensurePrivateBucket(s3, process.env.OBJECT_STORAGE_BUCKET!, process.env.OBJECT_STORAGE_CREATE_BUCKET === "true");
      storage = createPrivateObjectStorage(s3, process.env.OBJECT_STORAGE_BUCKET!);
    } else {
      storage = new MemoryStorage();
    }

    producerRedis = createBullMqRedisConnection({ url: redisUrl!, connectionName: `phase-five-e2e-producer-${organizationId}` });
    workerRedis = createBullMqRedisConnection({ url: redisUrl!, connectionName: `phase-five-e2e-worker-${organizationId}` });
    await Promise.all([connectRedis(producerRedis), connectRedis(workerRedis)]);
    producer = createCertificateGenerationProducer(producerRedis, queuePrefix);
    const processor = new CertificateGenerationProcessor({
      database,
      storage,
      verificationBaseUrl: "https://verify.example.invalid",
      verificationKeys: new Map([["key-2026-01", verificationKey]]),
      maximumAssetBytes: 2_000_000,
      maximumPdfBytes: 2_000_000,
      now: () => plannedIssuedAt,
      render: async (input, limits) => {
        capturedRenderInput = input as CertificateRenderInput;
        return renderCertificatePdf(input, limits);
      }
    });
    queueWorker = createCertificateGenerationWorker({
      connection: workerRedis,
      prefix: queuePrefix,
      concurrency: 1,
      process: (payload) => processor.process(payload),
      onFinalFailure: (payload) => processor.handleFinalFailure(payload)
    });
  });

  afterAll(async () => {
    const persistedKeys = await database.selectFrom("certificates").select("pdf_storage_key")
      .where("organization_id", "=", organizationId).where("pdf_storage_key", "is not", null).execute();
    await Promise.allSettled([...objectKeys, ...persistedKeys.map((row) => row.pdf_storage_key!)]
      .map((key) => storage.delete(key)));
    await Promise.allSettled([queueWorker.close(), producer.close(), app.close()]);
    const keys = await producerRedis.keys(`${queuePrefix}:*`);
    if (keys.length > 0) await producerRedis.del(...keys);
    await Promise.allSettled([closeRedis(producerRedis), closeRedis(workerRedis)]);
    s3?.destroy();
    await closeDatabase(database);
  });

  it("publishes an immutable planned certificate through API, outbox, BullMQ, renderer, and private storage", async () => {
    const idempotencyKey = `phase-five-e2e-${randomUUID()}`;
    const response = await request(app.server)
      .post(`/api/admin/trainings/${trainingId}/certificates/generate`)
      .set("x-organization-id", organizationId)
      .set("origin", "https://admin.example.invalid")
      .set("x-csrf-token", csrfToken)
      .set("idempotency-key", idempotencyKey)
      .send({ template_version_id: templateVersionId, participant_ids: [participantId] });
    expect(response.status).toBe(202);
    const jobId = response.body.data.job_id as string;

    const item = await database.selectFrom("certificate_generation_items").selectAll()
      .where("organization_id", "=", organizationId).where("job_id", "=", jobId).executeTakeFirstOrThrow();
    const snapshot = await database.selectFrom("certificate_issuance_snapshots").selectAll()
      .where("organization_id", "=", organizationId).where("certificate_id", "=", item.certificate_id).executeTakeFirstOrThrow();
    expect(snapshot).toMatchObject({
      recipient_display_name: "Snapshot Recipient",
      project_name: "Snapshot Project",
      training_name: "Snapshot Training",
      training_code: "P5-E2E"
    });
    expect(snapshot.issued_at.toISOString()).toBe(plannedIssuedAt.toISOString());
    expect(await database.selectFrom("queue_outbox").select("dispatched_at")
      .where("organization_id", "=", organizationId).where("deduplication_key", "=", `${jobId}-generate`)
      .executeTakeFirstOrThrow()).toEqual({ dispatched_at: null });

    const replay = await request(app.server)
      .post(`/api/admin/trainings/${trainingId}/certificates/generate`)
      .set("x-organization-id", organizationId)
      .set("origin", "https://admin.example.invalid")
      .set("x-csrf-token", csrfToken)
      .set("idempotency-key", idempotencyKey)
      .send({ template_version_id: templateVersionId, participant_ids: [participantId] });
    expect(replay.status).toBe(202);
    expect(replay.body.data.job_id).toBe(jobId);
    expect(await database.selectFrom("certificate_generation_items").select("id")
      .where("organization_id", "=", organizationId).where("job_id", "=", jobId).execute()).toHaveLength(1);

    await database.updateTable("queue_outbox").set({ created_at: new Date("1800-01-01T00:00:00.000Z") })
      .where("organization_id", "=", organizationId).where("deduplication_key", "=", `${jobId}-generate`).execute();

    await database.updateTable("participants").set({ display_name: "Changed Recipient" }).where("id", "=", participantId).execute();
    await database.updateTable("projects").set({ name: "Changed Project" }).where("id", "=", projectId).execute();
    await database.updateTable("trainings").set({ name: "Changed Training", code: "CHANGED" }).where("id", "=", trainingId).execute();

    const dispatcher = new QueueOutboxDispatcher({
      database,
      participantImports: { enqueue: async () => undefined, close: async () => undefined },
      certificateGenerations: producer,
      batchSize: 1,
      retryDelayMs: 0,
      reconcileAfterMs: 30_000
    });
    expect(await dispatcher.dispatchOnce()).toMatchObject({ dispatched: 1, failed: 0 });
    const completionDeadline = Date.now() + 15_000;
    while (true) {
      const job = await database.selectFrom("jobs").select(["status", "last_error_code"])
        .where("organization_id", "=", organizationId).where("id", "=", jobId).executeTakeFirstOrThrow();
      if (job.status === "SUCCEEDED") break;
      if (job.status === "DEAD_LETTER" || Date.now() >= completionDeadline) {
        throw new Error(`certificate generation did not succeed: ${job.status}:${job.last_error_code ?? "none"}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(capturedRenderInput?.bindings).toMatchObject({
      recipient: { displayName: "Snapshot Recipient" },
      project: { name: "Snapshot Project" },
      training: { name: "Snapshot Training", code: "P5-E2E" }
    });
    expect(capturedRenderInput?.bindings.verificationUrl).toMatch(/^https:\/\/verify\.example\.invalid\/verify#token=/);
    const certificate = await database.selectFrom("certificates").selectAll()
      .where("organization_id", "=", organizationId).where("id", "=", item.certificate_id).executeTakeFirstOrThrow();
    expect(certificate.status).toBe("AVAILABLE");
    expect(certificate.generation_revision).toBe(1);
    expect(certificate.issued_at?.toISOString()).toBe(plannedIssuedAt.toISOString());
    expect(certificate.pdf_storage_key).toBe(`certificates/${organizationId}/${certificate.id}/revision-1.pdf`);
    expect(certificate.pdf_storage_key).not.toMatch(/Snapshot|Changed|P5-E2E|@/);
    expect(certificate.pdf_mime_type).toBe("application/pdf");
    expect(Number(certificate.pdf_size_bytes)).toBeGreaterThan(0);
    expect(Number(certificate.pdf_size_bytes)).toBeLessThanOrEqual(2_000_000);
    objectKeys.push(certificate.pdf_storage_key!);
    const storedBytes = await storage.get(certificate.pdf_storage_key!, 2_000_000);
    expect(Buffer.from(storedBytes.subarray(0, 5)).toString("ascii")).toBe("%PDF-");
    expect(storedBytes.byteLength).toBe(Number(certificate.pdf_size_bytes));
    expect(Buffer.from(certificate.pdf_content_sha256!)).toEqual(createHash("sha256").update(storedBytes).digest());
    expect(await database.selectFrom("certificate_generation_items").select(["status", "generation_revision"])
      .where("id", "=", item.id).executeTakeFirstOrThrow()).toEqual({ status: "SUCCEEDED", generation_revision: 1 });
    expect(await database.selectFrom("jobs").select(["status", "progress_total", "progress_completed"])
      .where("id", "=", jobId).executeTakeFirstOrThrow()).toEqual({ status: "SUCCEEDED", progress_total: 1, progress_completed: 1 });
    expect((await database.selectFrom("queue_outbox").select("dispatched_at")
      .where("deduplication_key", "=", `${jobId}-generate`).executeTakeFirstOrThrow()).dispatched_at).not.toBeNull();
  }, 25_000);
});
