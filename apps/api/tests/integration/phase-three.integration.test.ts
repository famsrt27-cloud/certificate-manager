import { randomUUID } from "node:crypto";

import { closeDatabase, createDatabase, insertAuditRecord } from "@certificate-platform/database";
import type { EffectiveIdentity } from "@certificate-platform/domain";
import type { PrivateObjectStorage } from "@certificate-platform/storage";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApi } from "../../src/app.js";
import { ApplicationError } from "../../src/errors/application-error.js";
import { OrganizationAuthorizationService } from "../../src/modules/auth/organization-authorization-service.js";
import type { AuthenticatedContext, AuthenticationService } from "../../src/modules/auth/authentication-service.js";
import { PhaseThreeService } from "../../src/modules/phase-three/phase-three-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationEnabled = databaseUrl !== undefined && new URL(databaseUrl).pathname.toLowerCase().includes("test");

describe.skipIf(!integrationEnabled)("Phase 3 PostgreSQL and Fastify integration", () => {
  const database = createDatabase({ connectionString: databaseUrl!, maxConnections: 2 });
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const membershipId = randomUUID();
  const otherMembershipId = randomUUID();
  const otherProjectId = randomUUID();
  const otherTrainingId = randomUUID();
  const otherParticipantId = randomUUID();
  const otherJobId = randomUUID();
  const csrfToken = "c".repeat(43);
  const objects = new Map<string, Uint8Array>();
  let app: ReturnType<typeof buildApi>;
  let service: PhaseThreeService;
  let projectId = "";
  let trainingId = "";

  beforeAll(async () => {
    await database.insertInto("users").values([
      { id: userId, email: `phase3-${randomUUID()}@example.invalid`, password_hash: "synthetic" },
      { id: otherUserId, email: `phase3-other-${randomUUID()}@example.invalid`, password_hash: "synthetic" }
    ]).execute();
    await database.insertInto("organizations").values([
      { id: organizationId, name: "Synthetic Phase 3 Tenant" },
      { id: otherOrganizationId, name: "Other Synthetic Phase 3 Tenant" }
    ]).execute();
    await database.insertInto("organization_memberships").values([
      { id: membershipId, organization_id: organizationId, user_id: userId },
      { id: otherMembershipId, organization_id: otherOrganizationId, user_id: otherUserId }
    ]).execute();
    await database.insertInto("projects").values({ id: otherProjectId, organization_id: otherOrganizationId,
      name: "Foreign Synthetic Project", slug: `foreign-${randomUUID()}` }).execute();
    await database.insertInto("trainings").values({ id: otherTrainingId, organization_id: otherOrganizationId,
      project_id: otherProjectId, name: "Foreign Synthetic Training", code: `FOREIGN-${randomUUID()}` }).execute();
    await database.insertInto("participants").values({ id: otherParticipantId, organization_id: otherOrganizationId,
      display_name: "Foreign Synthetic Participant", external_reference: "FOREIGN-PRIVATE-REF" }).execute();
    await database.insertInto("jobs").values({ id: otherJobId, organization_id: otherOrganizationId,
      job_type: "PARTICIPANT_IMPORT", idempotency_key: `foreign-${randomUUID()}`,
      requested_by_membership_id: otherMembershipId }).execute();
    const identity: EffectiveIdentity = { user: { id: userId, email: "synthetic@example.invalid" }, systemRoles: [], memberships: [{
      id: membershipId, organizationId, organizationName: "Synthetic Phase 3 Tenant", roles: ["ORG_ADMIN"], permissions: [
        "project:create", "project:read", "project:update", "project:archive", "training:create", "training:read",
        "training:update", "training:archive", "participant:import", "participant:read", "participant:update", "job:read"
      ]
    }] };
    const authenticated: AuthenticatedContext = { sessionId: "s".repeat(43), session: { version: 1, userId, csrfToken,
      authorizationVersion: "a".repeat(64), createdAt: 1, lastSeenAt: 1, absoluteExpiresAt: 2 }, identity };
    const authentication = {
      authenticate: async () => authenticated,
      validateStateChangingRequest: (_context: AuthenticatedContext, origin: string | undefined, csrf: string | undefined) => {
        if (origin !== "https://admin.example.invalid" || csrf !== csrfToken) {
          throw new ApplicationError("REQUEST_FORBIDDEN", "The request could not be authorized.", 403);
        }
      }
    } as unknown as AuthenticationService;
    const audit = { write: (event: Parameters<typeof insertAuditRecord>[1]) => insertAuditRecord(database, event) };
    const storage: PrivateObjectStorage = {
      put: async (input) => { objects.set(input.key, input.body); },
      get: async (key) => objects.get(key) ?? Promise.reject(new Error("missing synthetic object")),
      delete: async (key) => { objects.delete(key); }
    };
    service = new PhaseThreeService({
      database,
      storage,
      cursorSecret: "synthetic-cursor-secret-at-least-32-bytes"
    });
    app = buildApi({ dependencies: { checkDatabase: async () => undefined, checkRedis: async () => undefined },
      readinessTimeoutMs: 100, logger: false,
      phaseThree: { authentication, authorization: new OrganizationAuthorizationService(authentication, audit), service,
        participantImportMaxBytes: 1_024 * 1_024 } });
    await app.ready();
  });

  afterAll(async () => {
    if (app !== undefined) await app.close();
    await closeDatabase(database);
  });

  const admin = (operation: request.Test) => operation.set("x-organization-id", organizationId)
    .set("origin", "https://admin.example.invalid").set("x-csrf-token", csrfToken);

  it("creates and reads tenant-scoped projects and trainings through canonical envelopes", async () => {
    const project = await admin(request(app.server).post("/api/admin/projects"))
      .send({ name: "Synthetic Project", slug: `synthetic-${randomUUID()}` });
    expect(project.status).toBe(201);
    projectId = project.body.data.id;
    const training = await admin(request(app.server).post("/api/admin/trainings"))
      .send({ project_id: projectId, name: "Synthetic Training", code: `CODE-${randomUUID()}`, start_date: "2026-08-18" });
    expect(training.status).toBe(201);
    trainingId = training.body.data.id;
    const listed = await request(app.server).get("/api/admin/trainings").set("x-organization-id", organizationId);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: trainingId, project_id: projectId })]));
  });

  it("rolls back a relational mutation when its audit insert fails", async () => {
    const slug = `audit-rollback-${randomUUID()}`;
    await expect(service.createProject({
      organizationId,
      actorUserId: userId,
      actorMembershipId: membershipId,
      membership: null,
      superAdmin: false
    }, {
      name: "Must Roll Back",
      slug
    }, "not-a-uuid")).rejects.toBeDefined();

    const persisted = await database.selectFrom("projects").select("id")
      .where("organization_id", "=", organizationId)
      .where("slug", "=", slug)
      .executeTakeFirst();
    expect(persisted).toBeUndefined();
  });

  it("stores participant import source privately and exposes only a queued job contract", async () => {
    const response = await admin(request(app.server).post(`/api/admin/trainings/${trainingId}/participants/import`))
      .set("idempotency-key", `import-${randomUUID()}`)
      .attach("file", Buffer.from("display_name,external_reference\nSynthetic Person,REF-1\n"), {
        filename: "synthetic.csv", contentType: "text/csv"
      });
    expect(response.status).toBe(202);
    expect(response.body.data.status).toBe("QUEUED");
    expect(JSON.stringify(response.body)).not.toContain("participant-imports/");
    expect(objects.size).toBe(1);
    const outbox = await database.selectFrom("queue_outbox")
      .select(["message_type", "deduplication_key", "payload_json", "dispatched_at"])
      .where("organization_id", "=", organizationId)
      .where("deduplication_key", "=", `${response.body.data.job_id}-validate`)
      .executeTakeFirstOrThrow();
    expect(outbox).toEqual(expect.objectContaining({
      message_type: "PARTICIPANT_IMPORT_VALIDATE",
      deduplication_key: `${response.body.data.job_id}-validate`,
      payload_json: {
        version: 1,
        job_id: response.body.data.job_id,
        organization_id: organizationId,
        operation: "VALIDATE"
      },
      dispatched_at: null
    }));
    const inspected = await request(app.server).get(`/api/admin/participant-imports/${response.body.data.job_id}`)
      .set("x-organization-id", organizationId);
    expect(inspected.status).toBe(200);
    expect(JSON.stringify(inspected.body)).not.toContain("source_storage_key");
  });

  it("rejects foreign project, training, participant, and job identifiers without side effects", async () => {
    for (const path of [
      `/api/admin/projects/${otherProjectId}`,
      `/api/admin/trainings/${otherTrainingId}`,
      `/api/admin/participants/${otherParticipantId}`,
      `/api/admin/jobs/${otherJobId}`,
      `/api/admin/participant-imports/${otherJobId}`
    ]) {
      expect((await request(app.server).get(path).set("x-organization-id", organizationId)).status).toBe(404);
    }

    const projectMutation = await admin(request(app.server).patch(`/api/admin/projects/${otherProjectId}`))
      .send({ name: "Cross-tenant mutation" });
    const participantMutation = await admin(request(app.server).patch(`/api/admin/participants/${otherParticipantId}`))
      .send({ display_name: "Cross-tenant mutation" });
    const nestedConfusion = await admin(request(app.server).post("/api/admin/trainings"))
      .send({ project_id: otherProjectId, name: "Cross-tenant training", code: `CROSS-${randomUUID()}` });
    expect(projectMutation.status).toBe(404);
    expect(participantMutation.status).toBe(404);
    expect(nestedConfusion.status).toBe(404);

    expect(await database.selectFrom("projects").select("name").where("id", "=", otherProjectId)
      .executeTakeFirstOrThrow()).toEqual({ name: "Foreign Synthetic Project" });
    expect(await database.selectFrom("participants").select("display_name").where("id", "=", otherParticipantId)
      .executeTakeFirstOrThrow()).toEqual({ display_name: "Foreign Synthetic Participant" });
    expect(await database.selectFrom("trainings").select("id").where("organization_id", "=", organizationId)
      .where("project_id", "=", otherProjectId).execute()).toHaveLength(0);
  });

  it("binds participant-import idempotency keys to the original training and source content under concurrency", async () => {
    const sameKey = `same-${randomUUID()}`;
    const sameBytes = Buffer.from("display_name,external_reference\nSame Request,REF-SAME\n");
    const objectCountBeforeSame = objects.size;

    const [firstSame, secondSame] = await Promise.all([
      admin(request(app.server).post(`/api/admin/trainings/${trainingId}/participants/import`))
        .set("idempotency-key", sameKey)
        .attach("file", sameBytes, { filename: "same.csv", contentType: "text/csv" }),
      admin(request(app.server).post(`/api/admin/trainings/${trainingId}/participants/import`))
        .set("idempotency-key", sameKey)
        .attach("file", sameBytes, { filename: "same-retry.csv", contentType: "text/csv" })
    ]);

    expect(firstSame.status).toBe(202);
    expect(secondSame.status).toBe(202);
    expect(firstSame.body.data.job_id).toBe(secondSame.body.data.job_id);
    expect(objects.size).toBe(objectCountBeforeSame + 1);

    const changedContent = await admin(request(app.server).post(`/api/admin/trainings/${trainingId}/participants/import`))
      .set("idempotency-key", sameKey)
      .attach("file", Buffer.from("display_name,external_reference\nChanged Request,REF-CHANGED\n"), {
        filename: "changed.csv", contentType: "text/csv"
      });
    expect(changedContent.status).toBe(409);

    const secondTraining = await admin(request(app.server).post("/api/admin/trainings"))
      .send({ project_id: projectId, name: "Synthetic Training 2", code: `CODE-${randomUUID()}` });
    expect(secondTraining.status).toBe(201);

    const changedTraining = await admin(request(app.server)
      .post(`/api/admin/trainings/${secondTraining.body.data.id}/participants/import`))
      .set("idempotency-key", sameKey)
      .attach("file", sameBytes, { filename: "same.csv", contentType: "text/csv" });
    expect(changedTraining.status).toBe(409);

    const sameRows = await database.selectFrom("jobs").select("id")
      .where("organization_id", "=", organizationId)
      .where("job_type", "=", "PARTICIPANT_IMPORT")
      .where("idempotency_key", "=", sameKey)
      .execute();
    expect(sameRows).toHaveLength(1);

    const competingKey = `competing-${randomUUID()}`;
    const objectCountBeforeCompeting = objects.size;
    const [left, right] = await Promise.all([
      admin(request(app.server).post(`/api/admin/trainings/${trainingId}/participants/import`))
        .set("idempotency-key", competingKey)
        .attach("file", Buffer.from("display_name\nLeft Winner\n"), {
          filename: "left.csv", contentType: "text/csv"
        }),
      admin(request(app.server).post(`/api/admin/trainings/${trainingId}/participants/import`))
        .set("idempotency-key", competingKey)
        .attach("file", Buffer.from("display_name\nRight Winner\n"), {
          filename: "right.csv", contentType: "text/csv"
        })
    ]);

    expect([left.status, right.status].sort()).toEqual([202, 409]);
    expect(objects.size).toBe(objectCountBeforeCompeting + 1);

    const competingRows = await database.selectFrom("jobs").select("id")
      .where("organization_id", "=", organizationId)
      .where("job_type", "=", "PARTICIPANT_IMPORT")
      .where("idempotency_key", "=", competingKey)
      .execute();
    expect(competingRows).toHaveLength(1);
  });
});
