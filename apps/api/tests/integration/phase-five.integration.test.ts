import { randomUUID } from "node:crypto";
import { closeDatabase, createDatabase, insertAuditRecord } from "@certificate-platform/database";
import type { EffectiveIdentity } from "@certificate-platform/domain";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApi } from "../../src/app.js";
import { ApplicationError } from "../../src/errors/application-error.js";
import { OrganizationAuthorizationService } from "../../src/modules/auth/organization-authorization-service.js";
import type { AuthenticatedContext, AuthenticationService } from "../../src/modules/auth/authentication-service.js";
import { PhaseFiveService } from "../../src/modules/phase-five/phase-five-service.js";
import type { AdminCertificatePdfService } from "../../src/modules/phase-six/admin-certificate-pdf-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = databaseUrl !== undefined && new URL(databaseUrl).pathname.toLowerCase().includes("test");

describe.skipIf(!enabled)("Phase Five generation API integration", () => {
  const database = createDatabase({ connectionString: databaseUrl!, maxConnections: 4 });
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  const trainingId = randomUUID();
  const otherTrainingId = randomUUID();
  const templateId = randomUUID();
  const otherTemplateId = randomUUID();
  const versionId = randomUUID();
  const draftVersionId = randomUUID();
  const otherVersionId = randomUUID();
  const otherParticipantId = randomUUID();
  const csrfToken = "c".repeat(43);
  let authenticated: AuthenticatedContext | null;
  let authorizedIdentity: EffectiveIdentity;
  let app: ReturnType<typeof buildApi>;
  let participantId: string;

  const addParticipant = async (displayName = "Phase Five Recipient"): Promise<string> => {
    const id = randomUUID();
    await database.insertInto("participants").values({ id, organization_id: organizationId, display_name: displayName, external_reference: null }).execute();
    await database.insertInto("training_participants").values({ organization_id: organizationId, training_id: trainingId, participant_id: id, source_import_job_id: null }).execute();
    return id;
  };

  beforeAll(async () => {
    await database.insertInto("users").values({ id: userId, email: `phase5-${randomUUID()}@example.invalid`, password_hash: "synthetic" }).execute();
    await database.insertInto("organizations").values([{ id: organizationId, name: "Phase Five Tenant" }, { id: otherOrganizationId, name: "Other Phase Five Tenant" }]).execute();
    await database.insertInto("organization_memberships").values({ id: membershipId, organization_id: organizationId, user_id: userId }).execute();
    await database.insertInto("projects").values([
      { id: projectId, organization_id: organizationId, name: "Phase Five Project", slug: `phase5-${randomUUID()}` },
      { id: otherProjectId, organization_id: otherOrganizationId, name: "Other Phase Five Project", slug: `phase5-other-${randomUUID()}` }
    ]).execute();
    await database.insertInto("trainings").values([
      { id: trainingId, organization_id: organizationId, project_id: projectId, name: "Phase Five Training", code: `P5-${randomUUID()}` },
      { id: otherTrainingId, organization_id: otherOrganizationId, project_id: otherProjectId, name: "Other Training", code: `P5O-${randomUUID()}` }
    ]).execute();
    participantId = await addParticipant();
    await database.insertInto("participants").values({ id: otherParticipantId, organization_id: otherOrganizationId,
      display_name: "Foreign Phase Five Recipient", external_reference: "FOREIGN-PRIVATE-REF" }).execute();
    await database.insertInto("training_participants").values({ organization_id: otherOrganizationId,
      training_id: otherTrainingId, participant_id: otherParticipantId, source_import_job_id: null }).execute();
    await database.insertInto("certificate_templates").values([
      { id: templateId, organization_id: organizationId, name: "Phase Five Template" },
      { id: otherTemplateId, organization_id: otherOrganizationId, name: "Other Phase Five Template" }
    ]).execute();
    await database.insertInto("template_versions").values([
      { id: versionId, organization_id: organizationId, template_id: templateId, version: 1, definition_json: { format_version: 1 }, status: "PUBLISHED", published_at: new Date() },
      { id: draftVersionId, organization_id: organizationId, template_id: templateId, version: 2, definition_json: { format_version: 1 }, status: "DRAFT" },
      { id: otherVersionId, organization_id: otherOrganizationId, template_id: otherTemplateId, version: 1, definition_json: { format_version: 1 }, status: "PUBLISHED", published_at: new Date() }
    ]).execute();
    authorizedIdentity = { user: { id: userId, email: "phase5@example.invalid" }, systemRoles: [], memberships: [{ id: membershipId, organizationId, organizationName: "Phase Five Tenant", roles: ["ORG_ADMIN"], permissions: ["certificate:generate"] }] };
    authenticated = { sessionId: "s".repeat(43), session: { version: 1, userId, csrfToken, authorizationVersion: "a".repeat(64), createdAt: 1, lastSeenAt: 1, absoluteExpiresAt: 2 }, identity: authorizedIdentity };
    const authentication = {
      authenticate: async () => authenticated,
      validateStateChangingRequest: (_context: AuthenticatedContext, origin?: string, csrf?: string) => {
        if (origin !== "https://admin.example.invalid" || csrf !== csrfToken) throw new ApplicationError("REQUEST_FORBIDDEN", "The request could not be authorized.", 403);
      }
    } as unknown as AuthenticationService;
    const authorization = new OrganizationAuthorizationService(authentication, { write: (event) => insertAuditRecord(database, event) });
    app = buildApi({ dependencies: { checkDatabase: async () => undefined, checkRedis: async () => undefined }, readinessTimeoutMs: 1_000, logger: false,
      phaseFive: { authentication, authorization, service: new PhaseFiveService({ database, verificationKeyKid: "key-2026-01",
        cursorSecret: "synthetic-phase-five-cursor-secret", now: () => new Date("2026-08-25T06:00:00Z") }),
        certificatePdf: { read: async () => { throw new Error("Not used by generation integration fixture"); } } as unknown as AdminCertificatePdfService } });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await closeDatabase(database);
  });

  const post = (key = `phase5-${randomUUID()}`, selectedTrainingId: string = trainingId) => request(app.server)
    .post(`/api/admin/trainings/${selectedTrainingId}/certificates/generate`)
    .set("x-organization-id", organizationId).set("origin", "https://admin.example.invalid")
    .set("x-csrf-token", csrfToken).set("idempotency-key", key);

  it("enforces authentication, organization authorization, Origin, CSRF, and idempotency", async () => {
    const prior = authenticated;
    authenticated = null;
    expect((await post().send({ template_version_id: versionId, participant_ids: [participantId] })).status).toBe(401);
    authenticated = prior;
    expect((await request(app.server).post(`/api/admin/trainings/${trainingId}/certificates/generate`).send({ template_version_id: versionId })).status).toBe(400);
    expect((await post().unset("x-csrf-token").send({ template_version_id: versionId })).status).toBe(403);
    expect((await post().set("origin", "https://evil.example.invalid").send({ template_version_id: versionId })).status).toBe(403);
    expect((await post().unset("idempotency-key").send({ template_version_id: versionId })).status).toBe(400);
    authenticated = { ...prior!, identity: { ...authorizedIdentity, memberships: [] } };
    expect((await post().send({ template_version_id: versionId })).status).toBe(403);
    authenticated = { ...prior!, identity: { ...authorizedIdentity, memberships: [{ ...authorizedIdentity.memberships[0]!, permissions: [] }] } };
    expect((await post().send({ template_version_id: versionId })).status).toBe(403);
    authenticated = prior;
  });

  it("rejects malformed input, duplicate IDs, and unpublished templates", async () => {
    expect((await post(undefined, "not-a-uuid").send({ template_version_id: versionId })).status).toBe(400);
    expect((await post().send({ template_version_id: "not-a-uuid" })).status).toBe(400);
    expect((await post().send({ template_version_id: versionId, participant_ids: [] })).status).toBe(400);
    expect((await post().send({ template_version_id: versionId, participant_ids: [participantId, participantId] })).status).toBe(400);
    expect((await post().send({ template_version_id: draftVersionId, participant_ids: [participantId] })).status).toBe(409);
  });

  it("keeps training and template lookups tenant scoped", async () => {
    expect((await post(undefined, otherTrainingId).send({ template_version_id: versionId })).status).toBe(404);
    expect((await post().send({ template_version_id: otherVersionId, participant_ids: [participantId] })).status).toBe(409);
    expect((await post().send({ template_version_id: versionId, participant_ids: [otherParticipantId] })).status).toBe(409);
    expect(await database.selectFrom("certificates").select("id")
      .where("participant_id", "=", otherParticipantId).execute()).toHaveLength(0);
  });

  it("plans through PostgreSQL/outbox and safely replays reordered IDs", async () => {
    const secondParticipantId = await addParticipant("Second Recipient");
    const key = `success-${randomUUID()}`;
    const response = await post(key).send({ template_version_id: versionId, participant_ids: [participantId, secondParticipantId] });
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ data: { job_id: expect.any(String), status: "QUEUED" }, meta: { request_id: expect.any(String) } });
    expect(JSON.stringify(response.body)).not.toMatch(/fingerprint|verification_key|storage|token|Recipient/);
    const outbox = await database.selectFrom("queue_outbox").select(["message_type", "payload_json", "dispatched_at"])
      .where("deduplication_key", "=", `${response.body.data.job_id}-generate`).executeTakeFirstOrThrow();
    expect(outbox).toEqual({ message_type: "CERTIFICATE_GENERATION", payload_json: { version: 1, job_id: response.body.data.job_id, organization_id: organizationId }, dispatched_at: null });
    const audit = await database.selectFrom("audit_logs").select(["organization_id", "actor_user_id", "actor_membership_id",
      "action", "resource_type", "resource_id", "request_id", "metadata"])
      .where("action", "=", "CERTIFICATE_GENERATION_REQUESTED").where("resource_id", "=", response.body.data.job_id)
      .executeTakeFirstOrThrow();
    expect(audit).toEqual({ organization_id: organizationId, actor_user_id: userId, actor_membership_id: membershipId,
      action: "CERTIFICATE_GENERATION_REQUESTED", resource_type: "certificate_generation",
      resource_id: response.body.data.job_id, request_id: response.body.meta.request_id,
      metadata: { training_id: trainingId, template_version_id: versionId, selection_mode: "EXPLICIT", participant_count: 2 } });
    const replay = await post(key).send({ template_version_id: versionId, participant_ids: [secondParticipantId, participantId] });
    expect(replay.status).toBe(202);
    expect(replay.body.data.job_id).toBe(response.body.data.job_id);
    expect(await database.selectFrom("queue_outbox").select("id").where("deduplication_key", "=", `${response.body.data.job_id}-generate`).execute()).toHaveLength(1);
    expect(await database.selectFrom("audit_logs").select("id").where("action", "=", "CERTIFICATE_GENERATION_REQUESTED")
      .where("resource_id", "=", response.body.data.job_id).execute()).toHaveLength(1);
  });

  it("maps explicit conflicts, ALL_ELIGIBLE no-work, and semantic key reuse to 409", async () => {
    expect((await post().send({ template_version_id: versionId, participant_ids: [participantId] })).status).toBe(409);
    expect((await post().send({ template_version_id: versionId })).status).toBe(409);
    const fresh = await addParticipant("Semantic Recipient");
    const key = `semantic-${randomUUID()}`;
    expect((await post(key).send({ template_version_id: versionId, participant_ids: [fresh] })).status).toBe(202);
    expect((await post(key).send({ template_version_id: versionId })).status).toBe(409);
  });

  it("keeps an ALL_ELIGIBLE replay bound to the original population", async () => {
    const first = await addParticipant("Population A");
    const second = await addParticipant("Population B");
    const key = `population-${randomUUID()}`;
    const planned = await post(key).send({ template_version_id: versionId });
    expect(planned.status).toBe(202);
    const later = await addParticipant("Population C");
    const replay = await post(key).send({ template_version_id: versionId });
    expect(replay.status).toBe(202);
    expect(replay.body.data.job_id).toBe(planned.body.data.job_id);
    const certificateParticipants = await database.selectFrom("certificate_generation_items as item")
      .innerJoin("certificates as certificate", "certificate.id", "item.certificate_id")
      .select("certificate.participant_id").where("item.job_id", "=", planned.body.data.job_id).execute();
    expect(certificateParticipants.map((row) => row.participant_id).sort()).toEqual([first, second].sort());
    expect(certificateParticipants.some((row) => row.participant_id === later)).toBe(false);
  });

  it("lists immutable tenant-scoped admin fields and revokes AVAILABLE certificates atomically", async () => {
    const prior = authenticated!;
    authenticated = { ...prior, identity: { ...authorizedIdentity, memberships: [{ ...authorizedIdentity.memberships[0]!,
      permissions: ["certificate:read", "certificate:revoke"] }] } };
    const row = await database.selectFrom("certificates as certificate")
      .innerJoin("certificate_generation_items as item", "item.certificate_id", "certificate.id")
      .select(["certificate.id", "item.id as item_id"]).where("certificate.organization_id", "=", organizationId)
      .where("certificate.status", "=", "DRAFT").executeTakeFirstOrThrow();
    const issuedAt = new Date("2026-08-25T06:00:00.000Z");
    await database.updateTable("certificates").set({ status: "GENERATING", updated_at: issuedAt }).where("id", "=", row.id).execute();
    await database.updateTable("certificate_generation_items").set({ status: "SUCCEEDED", updated_at: issuedAt }).where("id", "=", row.item_id).execute();
    await database.updateTable("certificates").set({ status: "AVAILABLE", issued_at: issuedAt,
      pdf_storage_key: `certificates/${row.id}/1.pdf`, pdf_content_sha256: Buffer.alloc(32, 4),
      pdf_size_bytes: "256", pdf_mime_type: "application/pdf", updated_at: issuedAt }).where("id", "=", row.id).execute();

    const listed = await request(app.server).get(`/api/admin/certificates?training_id=${trainingId}&status=AVAILABLE&limit=1`)
      .set("x-organization-id", organizationId);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([expect.objectContaining({ id: row.id, status: "AVAILABLE",
      recipient_display_name: expect.any(String), project_name: "Phase Five Project", training_name: "Phase Five Training" })]);
    expect(JSON.stringify(listed.body)).not.toMatch(/public_identifier|external_reference|storage|pdf_|sha|verification|kid|token/i);
    expect((await request(app.server).get("/api/admin/certificates").set("x-organization-id", otherOrganizationId)).status).toBe(403);

    const revokeRequest = () => request(app.server).post(`/api/admin/certificates/${row.id}/revoke`)
      .set("x-organization-id", organizationId).set("origin", "https://admin.example.invalid")
      .set("x-csrf-token", csrfToken).send({ reason: "ออกใบประกาศให้ผู้รับผิดราย" });
    const revoked = await revokeRequest();
    expect(revoked.status).toBe(200); expect(revoked.body.data).toEqual(expect.objectContaining({ id: row.id, status: "REVOKED",
      revocation_reason: "ออกใบประกาศให้ผู้รับผิดราย", revoked_at: expect.any(String) }));
    expect((await revokeRequest()).status).toBe(200);
    expect(await database.selectFrom("audit_logs").select("id").where("action", "=", "CERTIFICATE_REVOKED")
      .where("resource_id", "=", row.id).execute()).toHaveLength(1);
    const foreignCertificateId = randomUUID();
    await database.insertInto("certificates").values({ id: foreignCertificateId, organization_id: otherOrganizationId,
      training_id: otherTrainingId, participant_id: otherParticipantId, template_version_id: otherVersionId,
      certificate_number: `FOREIGN-${randomUUID()}`, verification_key_kid: "foreign-key" }).execute();
    await database.insertInto("certificate_issuance_snapshots").values({ certificate_id: foreignCertificateId,
      organization_id: otherOrganizationId, recipient_display_name: "Foreign Recipient", project_name: "Foreign Project",
      training_name: "Foreign Training", training_code: "FOREIGN", issued_at: issuedAt }).execute();
    expect((await request(app.server).post(`/api/admin/certificates/${foreignCertificateId}/revoke`)
      .set("x-organization-id", organizationId).set("origin", "https://admin.example.invalid")
      .set("x-csrf-token", csrfToken).send({ reason: "ห้ามข้ามองค์กร" })).status).toBe(404);
    authenticated = prior;
  });
});
