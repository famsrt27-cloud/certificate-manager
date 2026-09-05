import { createHash, randomUUID } from "node:crypto";

import {
  archiveTemplateAssetInTransaction,
  closeDatabase,
  createDatabase,
  insertAuditRecord,
  publishTemplateVersionInTransaction
} from "@certificate-platform/database";
import type { EffectiveIdentity } from "@certificate-platform/domain";
import type { PrivateObjectStorage } from "@certificate-platform/storage";
import request from "supertest";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApi } from "../../src/app.js";
import { ApplicationError } from "../../src/errors/application-error.js";
import type { AuthenticatedContext, AuthenticationService } from "../../src/modules/auth/authentication-service.js";
import { OrganizationAuthorizationService } from "../../src/modules/auth/organization-authorization-service.js";
import { PhaseFourService } from "../../src/modules/phase-four/phase-four-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationEnabled = databaseUrl !== undefined && new URL(databaseUrl).pathname.toLowerCase().includes("test");
const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const syntheticTtf = (() => {
  const bytes = Buffer.alloc(63); bytes[1] = 1; bytes.writeUInt16BE(3, 4);
  for (const [index, tag] of ["head", "name", "maxp"].entries()) {
    const record = 12 + index * 16; bytes.write(tag, record, "latin1"); bytes.writeUInt32BE(60 + index, record + 8);
    bytes.writeUInt32BE(1, record + 12); bytes[60 + index] = index + 1;
  }
  return bytes;
})();

describe.skipIf(!integrationEnabled)("Phase 4 PostgreSQL and Fastify integration", () => {
  const database = createDatabase({ connectionString: databaseUrl!, maxConnections: 2 });
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const otherMembershipId = randomUUID();
  const csrfToken = "c".repeat(43);
  const objects = new Map<string, Uint8Array>();
  let failStorageDeletes = false;
  let failStorageGets = false;
  let failStoragePutAt: number | null = null;
  let storagePutCount = 0;
  let onStorageGet: (() => Promise<void>) | null = null;
  let app: ReturnType<typeof buildApi>;
  let service: PhaseFourService;
  let templateId = "";
  let assetId = "";
  let versionId = "";

  beforeAll(async () => {
    await database.insertInto("users").values({ id: userId, email: `phase4-${randomUUID()}@example.invalid`, password_hash: "synthetic" }).execute();
    await database.insertInto("organizations").values([
      { id: organizationId, name: "Synthetic Phase 4 Tenant" }, { id: otherOrganizationId, name: "Other Synthetic Tenant" }
    ]).execute();
    await database.insertInto("organization_memberships").values([
      { id: membershipId, organization_id: organizationId, user_id: userId },
      { id: otherMembershipId, organization_id: otherOrganizationId, user_id: userId }
    ]).execute();
    const permissions = ["template:create", "template:read", "template:update", "template:asset:create", "template:publish"];
    const identity: EffectiveIdentity = { user: { id: userId, email: "synthetic@example.invalid" }, systemRoles: [], memberships: [
      { id: membershipId, organizationId, organizationName: "Synthetic Phase 4 Tenant", roles: ["TEMPLATE_MANAGER"], permissions },
      { id: otherMembershipId, organizationId: otherOrganizationId, organizationName: "Other Synthetic Tenant", roles: ["TEMPLATE_MANAGER"], permissions }
    ] };
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
      put: async (input) => {
        storagePutCount += 1;
        if (failStoragePutAt === storagePutCount) throw new Error("synthetic storage put failure");
        objects.set(input.key, input.body);
      },
      get: async (key) => {
        if (failStorageGets) throw new Error("synthetic storage read failure");
        const bytes = objects.get(key);
        if (bytes === undefined) throw new Error("missing synthetic object");
        const hook = onStorageGet; onStorageGet = null; await hook?.();
        return bytes;
      },
      delete: async (key) => {
        if (failStorageDeletes) throw new Error("synthetic storage delete failure");
        objects.delete(key);
      }
    };
    const testCursorKey = "synthetic-cursor-fixture-value-at-least-32-bytes";
    service = new PhaseFourService({ database, storage, cursorSecret: testCursorKey });
    app = buildApi({ dependencies: { checkDatabase: async () => undefined, checkRedis: async () => undefined },
      readinessTimeoutMs: 100, logger: false, phaseFour: { authentication,
        authorization: new OrganizationAuthorizationService(authentication, audit), service, templateAssetMaxBytes: 1_024 * 1_024 } });
    await app.ready();
  });

  afterAll(async () => {
    if (app !== undefined) await app.close();
    await closeDatabase(database);
  });

  const admin = (operation: request.Test, tenantId = organizationId) => operation.set("x-organization-id", tenantId)
    .set("origin", "https://admin.example.invalid").set("x-csrf-token", csrfToken);

  it("creates a template, validates a private asset, previews, and publishes atomically", async () => {
    const created = await admin(request(app.server).post("/api/admin/templates")).send({ name: "Secure Template" });
    expect(created.status).toBe(201);
    templateId = created.body.data.id;
    const uploaded = await admin(request(app.server).post(`/api/admin/templates/${templateId}/assets`))
      .attach("file", onePixelPng, { filename: "../../logo.png", contentType: "image/png" });
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.data.original_filename).toBe("logo.png");
    expect(JSON.stringify(uploaded.body)).not.toContain("template-assets/");
    assetId = uploaded.body.data.id;
    expect(objects.size).toBe(1);

    const definition = { format_version: 1, page: { width: 500, height: 300, unit: "px" }, elements: [
      { type: "text", x: 10, y: 10, width: 300, height: 40, font: { family: "Noto Sans Thai", size: 24 },
        binding: "recipient.display_name" },
      { type: "image", x: 10, y: 60, width: 50, height: 50, asset_id: assetId }
    ] };
    const version = await admin(request(app.server).post(`/api/admin/templates/${templateId}/versions`)).send({ definition });
    expect(version.status).toBe(201);
    versionId = version.body.data.id;
    const preview = await request(app.server).post(`/api/admin/templates/${templateId}/versions/${versionId}/preview`)
      .set("x-organization-id", organizationId);
    expect(preview.status).toBe(200);
    expect(preview.body.data.bound_elements[0].value).toBe("Preview Recipient");
    const published = await admin(request(app.server).post(`/api/admin/templates/${templateId}/versions/${versionId}/publish`));
    expect(published.status).toBe(200);
    expect(published.body.data.status).toBe("PUBLISHED");
    expect(published.body.data.published_at).toBeTruthy();
  });

  it("returns one bounded deterministic library preview per template with published preference", async () => {
    const definition = { format_version: 1, page: { width: 500, height: 300, unit: "px" }, elements: [
      { type: "text", x: 20, y: 20, width: 300, height: 40,
        font: { family: "Noto Sans Thai", size: 24 }, text: "Draft preview" }
    ] };
    const higherDraft = await admin(request(app.server).post(`/api/admin/templates/${templateId}/versions`)).send({ definition });
    expect(higherDraft.status).toBe(201);
    const draftOnly = await admin(request(app.server).post("/api/admin/templates")).send({ name: `Draft only ${randomUUID()}` });
    const draftOnlyVersion = await admin(request(app.server).post(`/api/admin/templates/${draftOnly.body.data.id}/versions`)).send({ definition });
    const empty = await admin(request(app.server).post("/api/admin/templates")).send({ name: `Empty ${randomUUID()}` });

    const listed = await request(app.server).get("/api/admin/templates?limit=100").set("x-organization-id", organizationId);
    expect(listed.status).toBe(200);
    const publishedItem = listed.body.data.find((item: { id: string }) => item.id === templateId);
    const draftItem = listed.body.data.find((item: { id: string }) => item.id === draftOnly.body.data.id);
    const emptyItem = listed.body.data.find((item: { id: string }) => item.id === empty.body.data.id);
    expect(publishedItem.preview).toMatchObject({ version: 1, status: "PUBLISHED" });
    expect(publishedItem.preview.definition.elements.some((element: { type: string }) => element.type === "image")).toBe(true);
    expect(draftItem.preview).toMatchObject({ version: draftOnlyVersion.body.data.version, status: "DRAFT", definition });
    expect(emptyItem.preview).toBeNull();
  });

  it("serves only tenant-scoped ACTIVE PNG/JPEG preview bytes and denies other templates, tenants, MIME types, and states", async () => {
    const context = { organizationId, actorUserId: userId, actorMembershipId: membershipId,
      membership: null, superAdmin: false } as const;
    const previewTemplate = await service.createTemplate(context, { name: `Preview ${randomUUID()}` }, randomUUID());
    const png = await service.uploadAsset(context, previewTemplate.id, { filename: "preview.png",
      declaredMimeType: "image/png", bytes: onePixelPng }, randomUUID());
    const jpegBytes = await sharp({ create: { width: 2, height: 1, channels: 3, background: "#ffffff" } }).jpeg().toBuffer();
    const jpeg = await service.uploadAsset(context, previewTemplate.id, { filename: "preview.jpg",
      declaredMimeType: "image/jpeg", bytes: jpegBytes }, randomUUID());

    for (const [asset, mime, bytes] of [[png, "image/png", onePixelPng], [jpeg, "image/jpeg", jpegBytes]] as const) {
      const response = await request(app.server).get(`/api/admin/templates/${previewTemplate.id}/assets/${asset.id}/content`)
        .set("x-organization-id", organizationId).buffer(true).parse((response, callback) => {
          const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => callback(null, Buffer.concat(chunks)));
        });
      expect(response.status).toBe(200); expect(response.headers["content-type"]).toContain(mime);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(Buffer.from(response.body as Buffer)).toEqual(Buffer.from(bytes));
      expect(JSON.stringify(response.headers)).not.toContain("template-assets/");
    }

    const otherTemplate = await service.createTemplate(context, { name: `Other ${randomUUID()}` }, randomUUID());
    expect((await request(app.server).get(`/api/admin/templates/${otherTemplate.id}/assets/${png.id}/content`)
      .set("x-organization-id", organizationId)).status).toBe(404);
    expect((await request(app.server).get(`/api/admin/templates/${previewTemplate.id}/assets/${png.id}/content`)
      .set("x-organization-id", otherOrganizationId)).status).toBe(404);

    const stateAsset = await service.uploadAsset(context, previewTemplate.id, { filename: "state.png",
      declaredMimeType: "image/png", bytes: onePixelPng }, randomUUID());
    for (const status of ["QUARANTINED", "REJECTED", "ARCHIVED"] as const) {
      await database.updateTable("template_assets").set({ status }).where("id", "=", stateAsset.id).execute();
      expect((await request(app.server).get(`/api/admin/templates/${previewTemplate.id}/assets/${stateAsset.id}/content`)
        .set("x-organization-id", organizationId)).status).toBe(404);
    }

    const fontId = randomUUID(); const fontKey = `template-assets/${organizationId}/${previewTemplate.id}/${fontId}/font.ttf`;
    const fontBytes = Buffer.alloc(64, 0); objects.set(fontKey, fontBytes);
    await database.insertInto("template_assets").values({ id: fontId, organization_id: organizationId,
      template_id: previewTemplate.id, storage_key: fontKey, original_filename: "private.ttf",
      content_sha256: createHash("sha256").update(fontBytes).digest(), detected_mime_type: "font/ttf",
      size_bytes: String(fontBytes.byteLength), width_px: null, height_px: null, status: "ACTIVE",
      created_by_membership_id: membershipId }).execute();
    expect((await request(app.server).get(`/api/admin/templates/${previewTemplate.id}/assets/${fontId}/content`)
      .set("x-organization-id", organizationId)).status).toBe(404);
  });

  it("rolls back an asset row and removes stored content when its audit insert fails", async () => {
    const objectCountBefore = objects.size;
    const filename = `audit-rollback-${randomUUID()}.png`;
    await expect(service.uploadAsset({
      organizationId,
      actorUserId: userId,
      actorMembershipId: membershipId,
      membership: null,
      superAdmin: false
    }, templateId, {
      filename,
      declaredMimeType: "image/png",
      bytes: onePixelPng
    }, "not-a-uuid")).rejects.toBeDefined();

    expect(objects.size).toBe(objectCountBefore);
    const persisted = await database.selectFrom("template_assets").select("id")
      .where("organization_id", "=", organizationId)
      .where("template_id", "=", templateId)
      .where("original_filename", "=", filename)
      .executeTakeFirst();
    expect(persisted).toBeUndefined();
  });

  it("keeps a durable cleanup intent when immediate object compensation fails", async () => {
    const objectCountBefore = objects.size;
    failStorageDeletes = true;
    try {
      await expect(service.uploadAsset({
        organizationId,
        actorUserId: userId,
        actorMembershipId: membershipId,
        membership: null,
        superAdmin: false
      }, templateId, {
        filename: `durable-cleanup-${randomUUID()}.png`,
        declaredMimeType: "image/png",
        bytes: onePixelPng
      }, "not-a-uuid")).rejects.toBeDefined();
    } finally {
      failStorageDeletes = false;
    }

    expect(objects.size).toBe(objectCountBefore + 1);
    const cleanup = await database.selectFrom("storage_cleanup_outbox")
      .select(["id", "object_key"])
      .where("organization_id", "=", organizationId)
      .orderBy("created_at", "desc")
      .executeTakeFirstOrThrow();
    expect(objects.has(cleanup.object_key)).toBe(true);

    objects.delete(cleanup.object_key);
    await database.deleteFrom("storage_cleanup_outbox").where("id", "=", cleanup.id).execute();
  });

  it("does not persist a ghost draft when version creation references an invalid asset", async () => {
    const context = {
      organizationId,
      actorUserId: userId,
      actorMembershipId: membershipId,
      membership: null,
      superAdmin: false
    } as const;
    const missingAssetId = randomUUID();
    const definition = {
      format_version: 1 as const,
      page: { width: 500, height: 300, unit: "px" as const },
      elements: [{
        type: "image" as const,
        x: 10,
        y: 10,
        width: 50,
        height: 50,
        opacity: 1,
        asset_id: missingAssetId,
        fit: "contain" as const
      }]
    };

    const before = await database.selectFrom("template_versions")
      .select(({ fn }) => fn.countAll().as("count"))
      .where("organization_id", "=", organizationId)
      .where("template_id", "=", templateId)
      .executeTakeFirstOrThrow();

    await expect(service.createVersion(context, templateId, { definition }, randomUUID()))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const after = await database.selectFrom("template_versions")
      .select(({ fn }) => fn.countAll().as("count"))
      .where("organization_id", "=", organizationId)
      .where("template_id", "=", templateId)
      .executeTakeFirstOrThrow();
    expect(Number(after.count)).toBe(Number(before.count));
  });

  it("clones draft, published, and archived versions into validated immutable drafts with scoped audit", async () => {
    const context = {
      organizationId,
      actorUserId: userId,
      actorMembershipId: membershipId,
      membership: null,
      superAdmin: false
    } as const;
    const template = await service.createTemplate(context, { name: `Clone source ${randomUUID()}` }, randomUUID());
    const asset = await service.uploadAsset(context, template.id, {
      filename: `clone-source-${randomUUID()}.png`, declaredMimeType: "image/png", bytes: onePixelPng
    }, randomUUID());
    const definition = {
      format_version: 1 as const,
      page: { width: 500, height: 300, unit: "px" as const },
      elements: [{ type: "image" as const, x: 10, y: 10, width: 50, height: 50, opacity: 1,
        asset_id: asset.id, fit: "contain" as const }]
    };
    const source = await service.createVersion(context, template.id, { definition }, randomUUID());
    const draftBefore = await service.getVersion(organizationId, template.id, source.id);

    const fromDraft = await admin(request(app.server)
      .post(`/api/admin/templates/${template.id}/versions/${source.id}/clone`));
    expect(fromDraft.status).toBe(201);
    expect(fromDraft.body.data).toMatchObject({ template_id: template.id, version: 2, status: "DRAFT",
      published_at: null, definition, asset_ids: [asset.id] });
    expect(await service.getVersion(organizationId, template.id, source.id)).toEqual(draftBefore);

    await service.publishVersion(context, template.id, source.id, randomUUID());
    const publishedBefore = await service.getVersion(organizationId, template.id, source.id);
    const fromPublished = await admin(request(app.server)
      .post(`/api/admin/templates/${template.id}/versions/${source.id}/clone`));
    expect(fromPublished.status).toBe(201);
    expect(fromPublished.body.data).toMatchObject({ version: 3, status: "DRAFT", published_at: null,
      definition, asset_ids: [asset.id] });
    expect(await service.getVersion(organizationId, template.id, source.id)).toEqual(publishedBefore);

    await service.archiveVersion(context, template.id, source.id, randomUUID());
    const archivedBefore = await service.getVersion(organizationId, template.id, source.id);
    const fromArchived = await admin(request(app.server)
      .post(`/api/admin/templates/${template.id}/versions/${source.id}/clone`));
    expect(fromArchived.status).toBe(201);
    expect(fromArchived.body.data).toMatchObject({ version: 4, status: "DRAFT", published_at: null,
      definition, asset_ids: [asset.id] });
    expect(await service.getVersion(organizationId, template.id, source.id)).toEqual(archivedBefore);

    const cloneAudits = await database.selectFrom("audit_logs")
      .select(["resource_id", "resource_type", "metadata"])
      .where("organization_id", "=", organizationId).where("action", "=", "TEMPLATE_VERSION_CLONED")
      .where("resource_id", "in", [fromDraft.body.data.id, fromPublished.body.data.id, fromArchived.body.data.id]).execute();
    expect(cloneAudits).toHaveLength(3);
    expect(new Set(cloneAudits.map((audit) => audit.resource_id))).toEqual(new Set([
      fromDraft.body.data.id, fromPublished.body.data.id, fromArchived.body.data.id
    ]));
    expect(cloneAudits.every((audit) => audit.resource_type === "template_version" && audit.metadata === null)).toBe(true);

    const otherTemplate = await service.createTemplate(context, { name: `Wrong clone target ${randomUUID()}` }, randomUUID());
    expect((await admin(request(app.server)
      .post(`/api/admin/templates/${otherTemplate.id}/versions/${source.id}/clone`))).status).toBe(404);
    expect((await admin(request(app.server)
      .post(`/api/admin/templates/${template.id}/versions/${source.id}/clone`), otherOrganizationId)).status).toBe(404);
    expect((await admin(request(app.server)
      .post(`/api/admin/templates/${template.id}/versions/${source.id}/clone`).send({ definition: { elements: [] } }))).status).toBe(400);
  });

  it("fails clone closed for an ineligible source asset without creating a version or audit", async () => {
    const context = {
      organizationId,
      actorUserId: userId,
      actorMembershipId: membershipId,
      membership: null,
      superAdmin: false
    } as const;
    const template = await service.createTemplate(context, { name: `Invalid clone asset ${randomUUID()}` }, randomUUID());
    const asset = await service.uploadAsset(context, template.id, {
      filename: `invalid-clone-${randomUUID()}.png`, declaredMimeType: "image/png", bytes: onePixelPng
    }, randomUUID());
    const source = await service.createVersion(context, template.id, { definition: {
      format_version: 1, page: { width: 500, height: 300, unit: "px" }, elements: [{
        type: "image", x: 10, y: 10, width: 50, height: 50, opacity: 1, asset_id: asset.id, fit: "contain"
      }]
    } }, randomUUID());
    await service.archiveAsset(context, template.id, asset.id, randomUUID());
    const before = await database.selectFrom("template_versions").select(({ fn }) => fn.countAll().as("count"))
      .where("organization_id", "=", organizationId).where("template_id", "=", template.id).executeTakeFirstOrThrow();
    const auditsBefore = await database.selectFrom("audit_logs").select(({ fn }) => fn.countAll().as("count"))
      .where("organization_id", "=", organizationId).where("action", "=", "TEMPLATE_VERSION_CLONED")
      .executeTakeFirstOrThrow();

    const response = await admin(request(app.server)
      .post(`/api/admin/templates/${template.id}/versions/${source.id}/clone`));
    expect(response.status).toBe(400);
    const after = await database.selectFrom("template_versions").select(({ fn }) => fn.countAll().as("count"))
      .where("organization_id", "=", organizationId).where("template_id", "=", template.id).executeTakeFirstOrThrow();
    expect(Number(after.count)).toBe(Number(before.count));
    const auditsAfter = await database.selectFrom("audit_logs").select(({ fn }) => fn.countAll().as("count"))
      .where("organization_id", "=", organizationId).where("action", "=", "TEMPLATE_VERSION_CLONED")
      .executeTakeFirstOrThrow();
    expect(Number(auditsAfter.count)).toBe(Number(auditsBefore.count));
  });

  it("serializes concurrent create and clone through the existing next-version allocator", async () => {
    const context = {
      organizationId,
      actorUserId: userId,
      actorMembershipId: membershipId,
      membership: null,
      superAdmin: false
    } as const;
    const template = await service.createTemplate(context, { name: `Concurrent clone ${randomUUID()}` }, randomUUID());
    const definition = { format_version: 1 as const, page: { width: 500, height: 300, unit: "px" as const }, elements: [] };
    const source = await service.createVersion(context, template.id, { definition }, randomUUID());
    const [cloned, created] = await Promise.all([
      service.cloneVersion(context, template.id, source.id, randomUUID()),
      service.createVersion(context, template.id, { definition }, randomUUID())
    ]);
    expect(new Set([cloned.version, created.version])).toEqual(new Set([2, 3]));
    expect(cloned.id).not.toBe(created.id);
    expect(cloned.status).toBe("DRAFT"); expect(created.status).toBe("DRAFT");
  });

  it("holds referenced asset locks through publish so a concurrent archive cannot invalidate the published version", async () => {
    const context = {
      organizationId,
      actorUserId: userId,
      actorMembershipId: membershipId,
      membership: null,
      superAdmin: false
    } as const;
    const template = await service.createTemplate(context, { name: `Publish race ${randomUUID()}` }, randomUUID());
    const asset = await service.uploadAsset(context, template.id, {
      filename: `publish-race-${randomUUID()}.png`,
      declaredMimeType: "image/png",
      bytes: onePixelPng
    }, randomUUID());
    const definition = {
      format_version: 1 as const,
      page: { width: 500, height: 300, unit: "px" as const },
      elements: [{
        type: "image" as const,
        x: 10,
        y: 10,
        width: 50,
        height: 50,
        opacity: 1,
        asset_id: asset.id,
        fit: "contain" as const
      }]
    };
    const draft = await service.createVersion(context, template.id, { definition }, randomUUID());

    let releasePublish!: () => void;
    let publishHasLockedAssets!: () => void;
    const publishLocked = new Promise<void>((resolve) => { publishHasLockedAssets = resolve; });
    const publishRelease = new Promise<void>((resolve) => { releasePublish = resolve; });

    const publishing = database.transaction().execute(async (transaction) => {
      const outcome = await publishTemplateVersionInTransaction(transaction, {
        organizationId,
        templateId: template.id,
        versionId: draft.id,
        validateDefinition: () => {
          publishHasLockedAssets();
          return true;
        }
      });
      expect(outcome).toBe("PUBLISHED");
      await publishRelease;
    });

    await publishLocked;

    const archiveOutcome = database.transaction().execute((transaction) =>
      archiveTemplateAssetInTransaction(transaction, organizationId, template.id, asset.id)
    ).then(
      (value) => ({ status: "resolved" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );

    const race = await Promise.race([
      archiveOutcome.then(() => "settled" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 100))
    ]);
    expect(race).toBe("pending");

    releasePublish();
    await publishing;

    const archived = await archiveOutcome;
    expect(archived.status).toBe("rejected");
    if (archived.status === "rejected") expect(archived.error).toMatchObject({ code: "P0001" });

    const persisted = await database.selectFrom("template_versions")
      .select("status")
      .where("organization_id", "=", organizationId)
      .where("id", "=", draft.id)
      .executeTakeFirstOrThrow();
    expect(persisted.status).toBe("PUBLISHED");
  });

  it("rolls back version creation and publish transition when their audit insert fails", async () => {
    const context = {
      organizationId,
      actorUserId: userId,
      actorMembershipId: membershipId,
      membership: null,
      superAdmin: false
    } as const;
    const definition = {
      format_version: 1 as const,
      page: { width: 500, height: 300, unit: "px" as const },
      elements: []
    };

    const before = await database.selectFrom("template_versions")
      .select(({ fn }) => fn.countAll().as("count"))
      .where("organization_id", "=", organizationId)
      .where("template_id", "=", templateId)
      .executeTakeFirstOrThrow();

    await expect(service.createVersion(context, templateId, { definition }, "not-a-uuid")).rejects.toBeDefined();

    const after = await database.selectFrom("template_versions")
      .select(({ fn }) => fn.countAll().as("count"))
      .where("organization_id", "=", organizationId)
      .where("template_id", "=", templateId)
      .executeTakeFirstOrThrow();
    expect(Number(after.count)).toBe(Number(before.count));

    const draft = await service.createVersion(context, templateId, { definition }, randomUUID());
    await expect(service.publishVersion(context, templateId, draft.id, "not-a-uuid")).rejects.toBeDefined();

    const persisted = await database.selectFrom("template_versions")
      .select(["status", "published_at"])
      .where("organization_id", "=", organizationId)
      .where("id", "=", draft.id)
      .executeTakeFirstOrThrow();
    expect(persisted.status).toBe("DRAFT");
    expect(persisted.published_at).toBeNull();
  });

  it("enforces nested template, version, and asset isolation even when the actor belongs to both tenants", async () => {
    const foreignTemplate = await admin(request(app.server).post("/api/admin/templates"), otherOrganizationId)
      .send({ name: "Foreign Secure Template" });
    expect(foreignTemplate.status).toBe(201);
    const foreignTemplateId = foreignTemplate.body.data.id as string;
    const foreignAsset = await admin(request(app.server).post(`/api/admin/templates/${foreignTemplateId}/assets`), otherOrganizationId)
      .attach("file", onePixelPng, { filename: "foreign-logo.png", contentType: "image/png" });
    expect(foreignAsset.status).toBe(201);
    const foreignVersion = await admin(request(app.server).post(`/api/admin/templates/${foreignTemplateId}/versions`), otherOrganizationId)
      .send({ definition: { format_version: 1, page: { width: 500, height: 300, unit: "px" }, elements: [] } });
    expect(foreignVersion.status).toBe(201);

    for (const path of [
      `/api/admin/templates/${foreignTemplateId}`,
      `/api/admin/templates/${foreignTemplateId}/versions/${foreignVersion.body.data.id}`,
      `/api/admin/templates/${foreignTemplateId}/assets/${foreignAsset.body.data.id}`
    ]) {
      expect((await request(app.server).get(path).set("x-organization-id", organizationId)).status).toBe(404);
    }
    for (const path of [
      `/api/admin/templates/${templateId}`,
      `/api/admin/templates/${templateId}/versions/${versionId}`,
      `/api/admin/templates/${templateId}/assets/${assetId}`
    ]) {
      expect((await request(app.server).get(path).set("x-organization-id", otherOrganizationId)).status).toBe(404);
    }

    const mutation = await admin(request(app.server).patch(`/api/admin/templates/${foreignTemplateId}`))
      .send({ name: "Cross-tenant mutation" });
    expect(mutation.status).toBe(404);
    const unchanged = await request(app.server).get(`/api/admin/templates/${foreignTemplateId}`)
      .set("x-organization-id", otherOrganizationId);
    expect(unchanged.status).toBe(200);
    expect(unchanged.body.data.name).toBe("Foreign Secure Template");
  });

  it("paginates version and asset lists with scoped opaque cursors", async () => {
    const definition = { format_version: 1, page: { width: 500, height: 300, unit: "px" }, elements: [
      { type: "text", x: 10, y: 10, width: 300, height: 40,
        font: { family: "Noto Sans Thai", size: 24 }, binding: "recipient.display_name" }
    ] };
    await admin(request(app.server).post(`/api/admin/templates/${templateId}/versions`)).send({ definition });
    await admin(request(app.server).post(`/api/admin/templates/${templateId}/versions`)).send({ definition });
    await admin(request(app.server).post(`/api/admin/templates/${templateId}/assets`))
      .attach("file", onePixelPng, { filename: "page-a.png", contentType: "image/png" });
    await admin(request(app.server).post(`/api/admin/templates/${templateId}/assets`))
      .attach("file", onePixelPng, { filename: "page-b.png", contentType: "image/png" });

    const versionsFirst = await admin(request(app.server)
      .get(`/api/admin/templates/${templateId}/versions?limit=1`));
    expect(versionsFirst.status).toBe(200);
    expect(versionsFirst.body.data).toHaveLength(1);
    expect(versionsFirst.body.meta.next_cursor).toEqual(expect.any(String));
    const versionsSecond = await admin(request(app.server)
      .get(`/api/admin/templates/${templateId}/versions?limit=1&cursor=${encodeURIComponent(versionsFirst.body.meta.next_cursor)}`));
    expect(versionsSecond.status).toBe(200);
    expect(versionsSecond.body.data[0].id).not.toBe(versionsFirst.body.data[0].id);

    const assetsFirst = await admin(request(app.server)
      .get(`/api/admin/templates/${templateId}/assets?limit=1`));
    expect(assetsFirst.status).toBe(200);
    expect(assetsFirst.body.data).toHaveLength(1);
    expect(assetsFirst.body.meta.next_cursor).toEqual(expect.any(String));
    expect((await admin(request(app.server)
      .get(`/api/admin/templates/${templateId}/assets?cursor=${encodeURIComponent(versionsFirst.body.meta.next_cursor)}`))).status).toBe(400);
    expect((await admin(request(app.server)
      .get(`/api/admin/templates/${templateId}/assets?cursor=${"a".repeat(2_049)}`))).status).toBe(400);
  });

  it("rejects multipart field, duplicate-file, missing-file, and malformed-boundary abuse without storing objects", async () => {
    const before = objects.size;
    const endpoint = `/api/admin/templates/${templateId}/assets`;
    expect((await admin(request(app.server).post(endpoint)).field("metadata", "unexpected")
      .attach("file", onePixelPng, { filename: "field.png", contentType: "image/png" })).status).toBe(400);
    expect((await admin(request(app.server).post(endpoint))
      .attach("file", onePixelPng, { filename: "first.png", contentType: "image/png" })
      .attach("file", onePixelPng, { filename: "second.png", contentType: "image/png" })).status).toBe(400);
    expect((await admin(request(app.server).post(endpoint)).set("content-type", "multipart/form-data; boundary=empty")
      .send("--empty--\r\n")).status).toBe(400);
    expect((await admin(request(app.server).post(endpoint)).set("content-type", "multipart/form-data; boundary=broken")
      .send("not-a-valid-multipart-body")).status).toBe(400);
    expect(objects.size).toBe(before);
  });

  it("rejects template asset bytes at the multipart boundary before private storage", async () => {
    const objectCount = objects.size;
    const response = await admin(request(app.server).post(`/api/admin/templates/${templateId}/assets`))
      .attach("file", Buffer.alloc(1_024 * 1_024 + 1, 0x61), { filename: "oversized.png", contentType: "image/png" });
    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe("UPLOAD_TOO_LARGE");
    expect(objects.size).toBe(objectCount);
  });

  it("duplicates selected draft, published, and archived versions into independent ACTIVE templates with DRAFT v1", async () => {
    const source = await admin(request(app.server).post("/api/admin/templates")).send({ name: `Duplicate source ${randomUUID()}` });
    const sourceTemplateId = source.body.data.id as string;
    const uploaded = await admin(request(app.server).post(`/api/admin/templates/${sourceTemplateId}/assets`))
      .attach("file", onePixelPng, { filename: "duplicate.png", contentType: "image/png" });
    const sourceAssetId = uploaded.body.data.id as string;
    const sourceAsset = await database.selectFrom("template_assets").selectAll().where("id", "=", sourceAssetId).executeTakeFirstOrThrow();
    const sourceBytes = Buffer.from(objects.get(sourceAsset.storage_key)!);
    const definition = { format_version: 1, page: { width: 500, height: 300, unit: "px" }, elements: [
      { type: "image", x: 0, y: 0, width: 50, height: 50, asset_id: sourceAssetId },
      { type: "signature", x: 60, y: 0, width: 50, height: 50, asset_id: sourceAssetId }
    ] };
    const draft = await admin(request(app.server).post(`/api/admin/templates/${sourceTemplateId}/versions`)).send({ definition });

    const duplicate = async (name: string) => admin(request(app.server).post(`/api/admin/templates/${sourceTemplateId}/duplicate`))
      .send({ source_version_id: draft.body.data.id, name });
    const draftCopy = await duplicate(`Draft copy ${randomUUID()}`);
    expect(draftCopy.status).toBe(201);
    await admin(request(app.server).post(`/api/admin/templates/${sourceTemplateId}/versions/${draft.body.data.id}/publish`));
    const publishedCopy = await duplicate(`Published copy ${randomUUID()}`);
    expect(publishedCopy.status).toBe(201);
    await admin(request(app.server).post(`/api/admin/templates/${sourceTemplateId}/versions/${draft.body.data.id}/archive`));
    await admin(request(app.server).post(`/api/admin/templates/${sourceTemplateId}/archive`));
    const archivedCopy = await duplicate(`Archived copy ${randomUUID()}`);
    expect(archivedCopy.status).toBe(201);

    for (const response of [draftCopy, publishedCopy, archivedCopy]) {
      expect(response.body.data.template).toMatchObject({ status: "ACTIVE" });
      expect(response.body.data.version).toMatchObject({ version: 1, status: "DRAFT", published_at: null });
      expect(response.body.data.template.id).not.toBe(sourceTemplateId);
      expect(response.body.data.version.template_id).toBe(response.body.data.template.id);
      expect(response.body.data.version.asset_ids).toHaveLength(1);
      expect(response.body.data.version.asset_ids).not.toContain(sourceAssetId);
      const destinationAssetId = response.body.data.version.asset_ids[0] as string;
      const destinationAsset = await database.selectFrom("template_assets").selectAll().where("id", "=", destinationAssetId)
        .executeTakeFirstOrThrow();
      expect(destinationAsset.template_id).toBe(response.body.data.template.id);
      expect(destinationAsset.storage_key).not.toBe(sourceAsset.storage_key);
      expect(destinationAsset.storage_key).toContain(`/` + response.body.data.template.id + `/`);
      expect(Buffer.from(destinationAsset.content_sha256)).toEqual(Buffer.from(sourceAsset.content_sha256));
      expect(destinationAsset.size_bytes).toBe(sourceAsset.size_bytes);
      expect(destinationAsset.detected_mime_type).toBe(sourceAsset.detected_mime_type);
      expect(Buffer.from(objects.get(destinationAsset.storage_key)!)).toEqual(sourceBytes);
      expect(response.body.data.version.definition.elements.map((element: { asset_id?: string }) => element.asset_id))
        .toEqual([destinationAssetId, destinationAssetId]);
      expect((await database.selectFrom("storage_cleanup_outbox").select("id")
        .where("object_key", "=", destinationAsset.storage_key).executeTakeFirst())).toBeUndefined();
    }
    expect(Buffer.from(objects.get(sourceAsset.storage_key)!)).toEqual(sourceBytes);
    const sourceVersions = await database.selectFrom("template_versions").selectAll().where("template_id", "=", sourceTemplateId).execute();
    expect(sourceVersions).toHaveLength(1);
    expect(sourceVersions[0]).toMatchObject({ id: draft.body.data.id, status: "ARCHIVED" });
    const audits = await database.selectFrom("audit_logs").selectAll().where("action", "=", "TEMPLATE_DUPLICATED")
      .where("resource_id", "in", [draftCopy.body.data.template.id, publishedCopy.body.data.template.id,
        archivedCopy.body.data.template.id]).execute();
    expect(audits).toHaveLength(3);
    expect(audits.every((audit) => audit.resource_type === "template" && audit.metadata === null)).toBe(true);
  });

  it("duplicates zero-asset definitions and rejects cross-template, cross-tenant, and injected source input", async () => {
    const source = await admin(request(app.server).post("/api/admin/templates")).send({ name: `Zero source ${randomUUID()}` });
    const version = await admin(request(app.server).post(`/api/admin/templates/${source.body.data.id}/versions`)).send({
      definition: { format_version: 1, page: { width: 500, height: 300, unit: "px" }, elements: [] }
    });
    const copy = await admin(request(app.server).post(`/api/admin/templates/${source.body.data.id}/duplicate`))
      .send({ source_version_id: version.body.data.id, name: `Zero copy ${randomUUID()}` });
    expect(copy.status).toBe(201); expect(copy.body.data.version.asset_ids).toEqual([]);
    expect((await admin(request(app.server).post(`/api/admin/templates/${templateId}/duplicate`))
      .send({ source_version_id: version.body.data.id, name: "Wrong source" })).status).toBe(404);
    expect((await admin(request(app.server).post(`/api/admin/templates/${source.body.data.id}/duplicate`), otherOrganizationId)
      .send({ source_version_id: version.body.data.id, name: "Foreign" })).status).toBe(404);
    expect((await admin(request(app.server).post(`/api/admin/templates/${source.body.data.id}/duplicate`))
      .send({ source_version_id: version.body.data.id, name: "Injected", asset_ids: [], storage_key: "private/key" })).status).toBe(400);
  });

  it("copies a referenced custom font to a new template-scoped asset and remaps only the font reference", async () => {
    const source = await admin(request(app.server).post("/api/admin/templates")).send({ name: `Font source ${randomUUID()}` });
    const uploaded = await admin(request(app.server).post(`/api/admin/templates/${source.body.data.id}/assets`))
      .attach("file", syntheticTtf, { filename: "private.ttf", contentType: "font/ttf" });
    expect(uploaded.status).toBe(201);
    const definition = { format_version: 1, page: { width: 500, height: 300, unit: "px" }, elements: [
      { type: "text", text: "literal remains", x: 0, y: 0, width: 300, height: 50,
        font: { family: "Private", asset_id: uploaded.body.data.id, size: 20 } }
    ] };
    const version = await admin(request(app.server).post(`/api/admin/templates/${source.body.data.id}/versions`)).send({ definition });
    const copy = await admin(request(app.server).post(`/api/admin/templates/${source.body.data.id}/duplicate`))
      .send({ source_version_id: version.body.data.id, name: `Font copy ${randomUUID()}` });
    expect(copy.status).toBe(201); expect(copy.body.data.version.asset_ids).toHaveLength(1);
    const destinationFontId = copy.body.data.version.asset_ids[0] as string;
    expect(destinationFontId).not.toBe(uploaded.body.data.id);
    expect(copy.body.data.version.definition.elements[0]).toMatchObject({ text: "literal remains",
      font: { family: "Private", asset_id: destinationFontId, size: 20 } });
    const [sourceRow, destinationRow] = await Promise.all([
      database.selectFrom("template_assets").selectAll().where("id", "=", uploaded.body.data.id).executeTakeFirstOrThrow(),
      database.selectFrom("template_assets").selectAll().where("id", "=", destinationFontId).executeTakeFirstOrThrow()
    ]);
    expect(destinationRow.storage_key).not.toBe(sourceRow.storage_key);
    expect(destinationRow.detected_mime_type).toBe("font/ttf");
    expect(Buffer.from(objects.get(destinationRow.storage_key)!)).toEqual(syntheticTtf);
    expect(Buffer.from(objects.get(sourceRow.storage_key)!)).toEqual(syntheticTtf);
  });

  it("compensates all destination objects and intents when a later sequential PUT fails", async () => {
    const context = { organizationId, actorUserId: userId, actorMembershipId: membershipId,
      membership: null, superAdmin: false } as const;
    const source = await service.createTemplate(context, { name: `Partial PUT source ${randomUUID()}` }, randomUUID());
    const image = await service.uploadAsset(context, source.id, { filename: "one.png", declaredMimeType: "image/png",
      bytes: onePixelPng }, randomUUID());
    const font = await service.uploadAsset(context, source.id, { filename: "two.ttf", declaredMimeType: "font/ttf",
      bytes: syntheticTtf }, randomUUID());
    const version = await service.createVersion(context, source.id, { definition: {
      format_version: 1, page: { width: 500, height: 300, unit: "px" }, elements: [
        { type: "image", x: 0, y: 0, width: 50, height: 50, opacity: 1, fit: "contain", asset_id: image.id },
        { type: "text", text: "private font", x: 0, y: 60, width: 300, height: 50, opacity: 1,
          align: "left", color: "#000000", font: { family: "Private", asset_id: font.id, size: 20, weight: 400 } }
      ]
    } }, randomUUID());
    const beforeObjects = objects.size; const name = `Partial PUT destination ${randomUUID()}`;
    failStoragePutAt = storagePutCount + 2;
    try {
      await expect(service.duplicateTemplate(context, source.id, { source_version_id: version.id, name },
        1_024 * 1_024, randomUUID())).rejects.toBeDefined();
    } finally {
      failStoragePutAt = null;
    }
    expect(objects.size).toBe(beforeObjects);
    expect((await database.selectFrom("certificate_templates").select("id").where("name", "=", name).executeTakeFirst()))
      .toBeUndefined();
    const dangling = await database.selectFrom("storage_cleanup_outbox").select("object_key")
      .where("object_key", "like", `template-assets/${organizationId}/%`).execute();
    expect(dangling.filter((row) => !objects.has(row.object_key))).toHaveLength(0);
  });

  it("fails closed on source object integrity/read failures and destination PUT failure without destination rows or success audit", async () => {
    const context = { organizationId, actorUserId: userId, actorMembershipId: membershipId,
      membership: null, superAdmin: false } as const;
    const source = await service.createTemplate(context, { name: `Failure source ${randomUUID()}` }, randomUUID());
    const asset = await service.uploadAsset(context, source.id, { filename: "failure.png", declaredMimeType: "image/png",
      bytes: onePixelPng }, randomUUID());
    const version = await service.createVersion(context, source.id, { definition: {
      format_version: 1, page: { width: 500, height: 300, unit: "px" }, elements: [
        { type: "image", x: 0, y: 0, width: 50, height: 50, opacity: 1, fit: "contain", asset_id: asset.id }
      ]
    } }, randomUUID());
    const assetRow = await database.selectFrom("template_assets").selectAll().where("id", "=", asset.id).executeTakeFirstOrThrow();
    const attempt = async (name: string) => admin(request(app.server).post(`/api/admin/templates/${source.id}/duplicate`))
      .send({ source_version_id: version.id, name });
    const countNamed = (name: string) => database.selectFrom("certificate_templates").select(({ fn }) => fn.countAll().as("count"))
      .where("name", "=", name).executeTakeFirstOrThrow();

    objects.set(assetRow.storage_key, Buffer.from("substituted"));
    const hashName = `Hash mismatch ${randomUUID()}`; expect((await attempt(hashName)).status).toBe(503);
    expect(Number((await countNamed(hashName)).count)).toBe(0);
    objects.set(assetRow.storage_key, onePixelPng);
    await database.updateTable("template_assets").set({ size_bytes: String(onePixelPng.byteLength + 1) }).where("id", "=", asset.id).execute();
    const sizeName = `Size mismatch ${randomUUID()}`; expect((await attempt(sizeName)).status).toBe(503);
    expect(Number((await countNamed(sizeName)).count)).toBe(0);
    await database.updateTable("template_assets").set({ size_bytes: String(onePixelPng.byteLength) }).where("id", "=", asset.id).execute();
    failStorageGets = true;
    const readName = `Read failure ${randomUUID()}`; expect((await attempt(readName)).status).toBe(503);
    failStorageGets = false; expect(Number((await countNamed(readName)).count)).toBe(0);
    failStoragePutAt = storagePutCount + 1;
    const putName = `Put failure ${randomUUID()}`; expect((await attempt(putName)).status).toBe(500);
    failStoragePutAt = null; expect(Number((await countNamed(putName)).count)).toBe(0);
    const audits = await database.selectFrom("audit_logs").select("id").where("action", "=", "TEMPLATE_DUPLICATED")
      .where("resource_id", "in", database.selectFrom("certificate_templates").select("id").where("name", "in", [hashName, sizeName, readName, putName]))
      .execute();
    expect(audits).toHaveLength(0);
  });

  it("keeps copied objects covered by cleanup intents when a final database transaction and immediate deletion both fail", async () => {
    const context = { organizationId, actorUserId: userId, actorMembershipId: membershipId,
      membership: null, superAdmin: false } as const;
    const source = await service.createTemplate(context, { name: `Cleanup source ${randomUUID()}` }, randomUUID());
    const asset = await service.uploadAsset(context, source.id, { filename: "cleanup.png", declaredMimeType: "image/png",
      bytes: onePixelPng }, randomUUID());
    const version = await service.createVersion(context, source.id, { definition: {
      format_version: 1, page: { width: 500, height: 300, unit: "px" }, elements: [
        { type: "image", x: 0, y: 0, width: 50, height: 50, opacity: 1, fit: "contain", asset_id: asset.id }
      ]
    } }, randomUUID());
    const destinationName = `Database rollback ${randomUUID()}`;
    failStorageDeletes = true;
    try {
      await expect(service.duplicateTemplate(context, source.id, { source_version_id: version.id, name: destinationName },
        1_024 * 1_024, "not-a-uuid")).rejects.toBeDefined();
    } finally {
      failStorageDeletes = false;
    }
    expect((await database.selectFrom("certificate_templates").select("id").where("name", "=", destinationName)
      .executeTakeFirst())).toBeUndefined();
    const cleanup = await database.selectFrom("storage_cleanup_outbox").select(["id", "object_key"])
      .where("object_key", "like", `template-assets/${organizationId}/%`).execute();
    const destinationCleanup = cleanup.filter((row) => objects.has(row.object_key));
    expect(destinationCleanup).toHaveLength(1);
    expect(destinationCleanup[0]!.object_key).not.toContain(`/${source.id}/`);
    for (const row of destinationCleanup) {
      objects.delete(row.object_key);
      await database.deleteFrom("storage_cleanup_outbox").where("id", "=", row.id).execute();
    }
  });

  it("rejects an ineligible source asset without copying storage or creating a destination", async () => {
    const context = { organizationId, actorUserId: userId, actorMembershipId: membershipId,
      membership: null, superAdmin: false } as const;
    const source = await service.createTemplate(context, { name: `Ineligible duplicate ${randomUUID()}` }, randomUUID());
    const asset = await service.uploadAsset(context, source.id, { filename: "archived.png", declaredMimeType: "image/png",
      bytes: onePixelPng }, randomUUID());
    const version = await service.createVersion(context, source.id, { definition: {
      format_version: 1, page: { width: 500, height: 300, unit: "px" }, elements: [
        { type: "image", x: 0, y: 0, width: 50, height: 50, opacity: 1, fit: "contain", asset_id: asset.id }
      ]
    } }, randomUUID());
    await database.updateTable("template_assets").set({ status: "ARCHIVED" }).where("id", "=", asset.id).execute();
    const beforeObjects = objects.size; const name = `Must not exist ${randomUUID()}`;
    const response = await admin(request(app.server).post(`/api/admin/templates/${source.id}/duplicate`))
      .send({ source_version_id: version.id, name });
    expect(response.status).toBe(400); expect(objects.size).toBe(beforeObjects);
    expect((await database.selectFrom("certificate_templates").select("id").where("name", "=", name).executeTakeFirst()))
      .toBeUndefined();
  });

  it("revalidates source asset identity and status inside the final transaction", async () => {
    const context = { organizationId, actorUserId: userId, actorMembershipId: membershipId,
      membership: null, superAdmin: false } as const;
    const source = await service.createTemplate(context, { name: `TOCTOU source ${randomUUID()}` }, randomUUID());
    const asset = await service.uploadAsset(context, source.id, { filename: "toctou.png", declaredMimeType: "image/png",
      bytes: onePixelPng }, randomUUID());
    const version = await service.createVersion(context, source.id, { definition: {
      format_version: 1, page: { width: 500, height: 300, unit: "px" }, elements: [
        { type: "image", x: 0, y: 0, width: 50, height: 50, opacity: 1, fit: "contain", asset_id: asset.id }
      ]
    } }, randomUUID());
    onStorageGet = async () => {
      await database.updateTable("template_assets").set({ status: "ARCHIVED" }).where("id", "=", asset.id).execute();
    };
    const beforeObjects = objects.size; const name = `TOCTOU destination ${randomUUID()}`;
    const response = await admin(request(app.server).post(`/api/admin/templates/${source.id}/duplicate`))
      .send({ source_version_id: version.id, name });
    expect(response.status).toBe(409);
    expect((await database.selectFrom("certificate_templates").select("id").where("name", "=", name).executeTakeFirst()))
      .toBeUndefined();
    expect(objects.size).toBe(beforeObjects);
  });

  it("rejects a DRAFT source definition change during object copying instead of combining snapshots", async () => {
    const context = { organizationId, actorUserId: userId, actorMembershipId: membershipId,
      membership: null, superAdmin: false } as const;
    const source = await service.createTemplate(context, { name: `Draft TOCTOU source ${randomUUID()}` }, randomUUID());
    const asset = await service.uploadAsset(context, source.id, { filename: "draft-toctou.png", declaredMimeType: "image/png",
      bytes: onePixelPng }, randomUUID());
    const version = await service.createVersion(context, source.id, { definition: {
      format_version: 1, page: { width: 500, height: 300, unit: "px" }, elements: [
        { type: "image", x: 0, y: 0, width: 50, height: 50, opacity: 1, fit: "contain", asset_id: asset.id }
      ]
    } }, randomUUID());
    onStorageGet = async () => {
      await service.updateVersion(context, source.id, version.id, { definition: {
        format_version: 1, page: { width: 500, height: 300, unit: "px" }, elements: []
      } }, randomUUID());
    };
    const beforeObjects = objects.size; const name = `Draft TOCTOU destination ${randomUUID()}`;
    const response = await admin(request(app.server).post(`/api/admin/templates/${source.id}/duplicate`))
      .send({ source_version_id: version.id, name });
    expect(response.status).toBe(409);
    expect((await database.selectFrom("certificate_templates").select("id").where("name", "=", name).executeTakeFirst()))
      .toBeUndefined();
    expect(objects.size).toBe(beforeObjects);
    expect((await service.getVersion(organizationId, source.id, version.id)).asset_ids).toEqual([]);
  });

  it("enforces published definition, asset-link, and asset-content immutability in PostgreSQL", async () => {
    await expect(database.updateTable("template_versions").set({ definition_json: { format_version: 1 } })
      .where("id", "=", versionId).execute()).rejects.toMatchObject({ code: "P0001" });
    await expect(database.deleteFrom("template_version_assets").where("template_version_id", "=", versionId).execute())
      .rejects.toMatchObject({ code: "P0001" });
    await expect(database.updateTable("template_assets").set({ status: "ARCHIVED" }).where("id", "=", assetId).execute())
      .rejects.toMatchObject({ code: "P0001" });
    const apiMutation = await admin(request(app.server).patch(`/api/admin/templates/${templateId}/versions/${versionId}`))
      .send({ definition: { format_version: 1, page: { width: 500, height: 300, unit: "px" }, elements: [] } });
    expect(apiMutation.status).toBe(404);
  });
});
