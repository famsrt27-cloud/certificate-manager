import { randomUUID } from "node:crypto";

import { closeDatabase, createDatabase, insertAuditRecord } from "@certificate-platform/database";
import type { EffectiveIdentity } from "@certificate-platform/domain";
import type { PrivateObjectStorage } from "@certificate-platform/storage";
import request from "supertest";
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
  let app: ReturnType<typeof buildApi>;
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
      delete: async (key) => { objects.delete(key); }
    };
    const testCursorKey = "synthetic-cursor-fixture-value-at-least-32-bytes";
    const service = new PhaseFourService({ database, storage, audit, cursorSecret: testCursorKey });
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

  it("enforces tenant isolation even when the actor is a member of both tenants", async () => {
    const response = await request(app.server).get(`/api/admin/templates/${templateId}`).set("x-organization-id", otherOrganizationId);
    expect(response.status).toBe(404);
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
