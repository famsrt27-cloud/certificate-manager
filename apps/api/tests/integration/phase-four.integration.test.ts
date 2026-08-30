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
      put: async (input) => { objects.set(input.key, input.body); },
      get: async (key) => objects.get(key) ?? Promise.reject(new Error("missing synthetic object")),
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
