import type { EffectiveIdentity } from "@certificate-platform/domain";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { buildApi } from "../../apps/api/src/app.js";
import { ApplicationError } from "../../apps/api/src/errors/application-error.js";
import type { AuthenticatedContext, AuthenticationService } from "../../apps/api/src/modules/auth/authentication-service.js";
import { OrganizationAuthorizationService } from "../../apps/api/src/modules/auth/organization-authorization-service.js";
import type { PhaseFourService } from "../../apps/api/src/modules/phase-four/phase-four-service.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const otherOrganizationId = "00000000-0000-4000-8000-000000000002";

const buildFixture = (permissions: readonly string[]) => {
  const identity: EffectiveIdentity = { user: { id: "00000000-0000-4000-8000-000000000004", email: "synthetic@example.invalid" },
    systemRoles: [], memberships: [{ id: "00000000-0000-4000-8000-000000000003", organizationId,
      organizationName: "Synthetic Tenant", roles: ["VIEWER"], permissions }] };
  const authenticated: AuthenticatedContext = { sessionId: "s".repeat(43), session: { version: 1, userId: identity.user.id,
    csrfToken: "c".repeat(43), authorizationVersion: "a".repeat(64), createdAt: 1, lastSeenAt: 1, absoluteExpiresAt: 2 }, identity };
  const authentication = { authenticate: vi.fn().mockResolvedValue(authenticated),
    validateStateChangingRequest: vi.fn((_context, origin: string | undefined, csrfToken: string | undefined) => {
      if (origin !== "https://admin.example.invalid" || csrfToken !== "c".repeat(43)) {
        throw new ApplicationError("REQUEST_FORBIDDEN", "The request could not be authorized.", 403);
      }
    }) } as unknown as AuthenticationService;
  const audit = { write: vi.fn().mockResolvedValue(undefined) };
  const service = { listTemplates: vi.fn().mockResolvedValue({ data: [], nextCursor: null }),
    createTemplate: vi.fn().mockResolvedValue({ id: "00000000-0000-4000-8000-000000000005", name: "Safe", status: "ACTIVE" }),
    duplicateTemplate: vi.fn().mockResolvedValue({
      template: { id: "00000000-0000-4000-8000-000000000008", name: "Independent", status: "ACTIVE" },
      version: { id: "00000000-0000-4000-8000-000000000009", template_id: "00000000-0000-4000-8000-000000000008",
        version: 1, definition: { format_version: 1, page: { width: 100, height: 100, unit: "px" }, elements: [] },
        asset_ids: [], status: "DRAFT", published_at: null }
    }),
    cloneVersion: vi.fn().mockResolvedValue({ id: "00000000-0000-4000-8000-000000000007",
      template_id: "00000000-0000-4000-8000-000000000005", version: 2,
      definition: { format_version: 1, page: { width: 100, height: 100, unit: "px" }, elements: [] },
      asset_ids: [], status: "DRAFT", published_at: null }), publishVersion: vi.fn() } as unknown as PhaseFourService;
  const app = buildApi({ dependencies: { checkDatabase: vi.fn(), checkRedis: vi.fn() }, readinessTimeoutMs: 100, logger: false,
    phaseFour: { authentication, authorization: new OrganizationAuthorizationService(authentication, audit), service,
      templateAssetMaxBytes: 1_024 } });
  return { app, service: service as unknown as { listTemplates: ReturnType<typeof vi.fn>; createTemplate: ReturnType<typeof vi.fn>;
    cloneVersion: ReturnType<typeof vi.fn>; duplicateTemplate: ReturnType<typeof vi.fn>; publishVersion: ReturnType<typeof vi.fn> } };
};

describe("Phase 4 authorization and tenant abuse cases", () => {
  it("blocks a cross-tenant selector before repository/service access", async () => {
    const fixture = buildFixture(["template:read"]); await fixture.app.ready();
    expect((await request(fixture.app.server).get("/api/admin/templates").set("x-organization-id", otherOrganizationId)).status).toBe(403);
    expect(fixture.service.listTemplates).not.toHaveBeenCalled(); await fixture.app.close();
  });

  it("blocks VIEWER create/publish attempts even with forged role fields", async () => {
    const fixture = buildFixture(["template:read"]); await fixture.app.ready();
    const create = await request(fixture.app.server).post("/api/admin/templates").set("x-organization-id", organizationId)
      .set("origin", "https://admin.example.invalid").set("x-csrf-token", "c".repeat(43))
      .send({ name: "Forbidden", roles: ["TEMPLATE_MANAGER"] });
    const publish = await request(fixture.app.server)
      .post("/api/admin/templates/00000000-0000-4000-8000-000000000005/versions/00000000-0000-4000-8000-000000000006/publish")
      .set("x-organization-id", organizationId).set("origin", "https://admin.example.invalid").set("x-csrf-token", "c".repeat(43));
    expect(create.status).toBe(403); expect(publish.status).toBe(403);
    expect(fixture.service.createTemplate).not.toHaveBeenCalled(); expect(fixture.service.publishVersion).not.toHaveBeenCalled();
    await fixture.app.close();
  });

  it("validates CSRF before a permitted mutation", async () => {
    const fixture = buildFixture(["template:create"]); await fixture.app.ready();
    const response = await request(fixture.app.server).post("/api/admin/templates").set("x-organization-id", organizationId)
      .set("origin", "https://admin.example.invalid").send({ name: "Safe" });
    expect(response.status).toBe(403); expect(fixture.service.createTemplate).not.toHaveBeenCalled(); await fixture.app.close();
  });

  it("rejects clone without template edit permission and enforces origin and CSRF before service access", async () => {
    const sourcePath = "/api/admin/templates/00000000-0000-4000-8000-000000000005/versions/00000000-0000-4000-8000-000000000006/clone";
    const unauthorized = buildFixture(["template:read"]); await unauthorized.app.ready();
    expect((await request(unauthorized.app.server).post(sourcePath).set("x-organization-id", organizationId)
      .set("origin", "https://admin.example.invalid").set("x-csrf-token", "c".repeat(43))).status).toBe(403);
    expect(unauthorized.service.cloneVersion).not.toHaveBeenCalled(); await unauthorized.app.close();

    const missingCsrf = buildFixture(["template:update"]); await missingCsrf.app.ready();
    expect((await request(missingCsrf.app.server).post(sourcePath).set("x-organization-id", organizationId)
      .set("origin", "https://admin.example.invalid")).status).toBe(403);
    expect(missingCsrf.service.cloneVersion).not.toHaveBeenCalled(); await missingCsrf.app.close();

    const wrongOrigin = buildFixture(["template:update"]); await wrongOrigin.app.ready();
    expect((await request(wrongOrigin.app.server).post(sourcePath).set("x-organization-id", organizationId)
      .set("origin", "https://other.example.invalid").set("x-csrf-token", "c".repeat(43))).status).toBe(403);
    expect(wrongOrigin.service.cloneVersion).not.toHaveBeenCalled(); await wrongOrigin.app.close();
  });

  it("accepts only an empty clone request and passes source identity from the route", async () => {
    const fixture = buildFixture(["template:update"]); await fixture.app.ready();
    const sourcePath = "/api/admin/templates/00000000-0000-4000-8000-000000000005/versions/00000000-0000-4000-8000-000000000006/clone";
    const headers = (operation: request.Test) => operation.set("x-organization-id", organizationId)
      .set("origin", "https://admin.example.invalid").set("x-csrf-token", "c".repeat(43));
    expect((await headers(request(fixture.app.server).post(sourcePath)).send({ definition: {} })).status).toBe(400);
    expect(fixture.service.cloneVersion).not.toHaveBeenCalled();

    const response = await headers(request(fixture.app.server).post(sourcePath));
    expect(response.status).toBe(201); expect(response.body.data).toMatchObject({ version: 2, status: "DRAFT", published_at: null });
    expect(fixture.service.cloneVersion).toHaveBeenCalledWith(expect.objectContaining({ organizationId }),
      "00000000-0000-4000-8000-000000000005", "00000000-0000-4000-8000-000000000006", expect.any(String));
    await fixture.app.close();
  });

  it("protects duplicate-template with create permission, origin, CSRF, and a strict server-derived request", async () => {
    const path = "/api/admin/templates/00000000-0000-4000-8000-000000000005/duplicate";
    const body = { source_version_id: "00000000-0000-4000-8000-000000000006", name: "Independent" };
    const unauthorized = buildFixture(["template:read"]); await unauthorized.app.ready();
    expect((await request(unauthorized.app.server).post(path).set("x-organization-id", organizationId)
      .set("origin", "https://admin.example.invalid").set("x-csrf-token", "c".repeat(43)).send(body)).status).toBe(403);
    expect(unauthorized.service.duplicateTemplate).not.toHaveBeenCalled(); await unauthorized.app.close();

    const fixture = buildFixture(["template:create"]); await fixture.app.ready();
    const authorized = (operation: request.Test) => operation.set("x-organization-id", organizationId)
      .set("origin", "https://admin.example.invalid").set("x-csrf-token", "c".repeat(43));
    expect((await authorized(request(fixture.app.server).post(path)).send({ ...body, definition: {} })).status).toBe(400);
    expect((await authorized(request(fixture.app.server)
      .post("/api/admin/templates/not-a-uuid/duplicate")).send(body)).status).toBe(400);
    expect((await authorized(request(fixture.app.server).post(path))
      .send({ ...body, source_version_id: "not-a-uuid" })).status).toBe(400);
    expect((await request(fixture.app.server).post(path).set("x-organization-id", organizationId)
      .set("origin", "https://admin.example.invalid").send(body)).status).toBe(403);
    expect((await request(fixture.app.server).post(path).set("x-organization-id", organizationId)
      .set("origin", "https://other.example.invalid").set("x-csrf-token", "c".repeat(43)).send(body)).status).toBe(403);
    expect(fixture.service.duplicateTemplate).not.toHaveBeenCalled();
    const response = await authorized(request(fixture.app.server).post(path)).send(body);
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ template: { name: "Independent", status: "ACTIVE" },
      version: { version: 1, status: "DRAFT", published_at: null } });
    expect(JSON.stringify(response.body)).not.toMatch(/storage_key|template-assets\//);
    expect(fixture.service.duplicateTemplate).toHaveBeenCalledWith(expect.objectContaining({ organizationId }),
      "00000000-0000-4000-8000-000000000005", body, 1_024, expect.any(String));
    await fixture.app.close();
  });
});
