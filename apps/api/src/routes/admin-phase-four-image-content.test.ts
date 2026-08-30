import type { EffectiveIdentity } from "@certificate-platform/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApi } from "../app.js";
import type { AuthenticatedContext, AuthenticationService } from "../modules/auth/authentication-service.js";
import { OrganizationAuthorizationService } from "../modules/auth/organization-authorization-service.js";
import type { PhaseFourService } from "../modules/phase-four/phase-four-service.js";

const organizationId = "10000000-0000-4000-8000-000000000001";
const membershipId = "10000000-0000-4000-8000-000000000002";
const userId = "10000000-0000-4000-8000-000000000003";
const templateId = "10000000-0000-4000-8000-000000000004";
const assetId = "10000000-0000-4000-8000-000000000005";

const contextFor = (permissions: readonly string[]): AuthenticatedContext => {
  const identity: EffectiveIdentity = { user: { id: userId, email: "preview@example.invalid" }, systemRoles: [], memberships: [{
    id: membershipId, organizationId, organizationName: "Preview Tenant", roles: ["TEMPLATE_MANAGER"], permissions: [...permissions]
  }] };
  return { sessionId: "s".repeat(43), session: { version: 1, userId, csrfToken: "c".repeat(43),
    authorizationVersion: "a".repeat(64), createdAt: 1, lastSeenAt: 1, absoluteExpiresAt: 2 }, identity };
};

const createApp = async (context: AuthenticatedContext | null, getActiveImageContent = vi.fn(async () => ({
  bytes: new Uint8Array([137, 80, 78, 71]), mimeType: "image/png" as const
}))) => {
  const authentication = { authenticate: async () => context } as unknown as AuthenticationService;
  const authorization = new OrganizationAuthorizationService(authentication, { write: async () => undefined });
  const service = { getActiveImageContent } as unknown as PhaseFourService;
  const app = buildApi({ dependencies: { checkDatabase: async () => undefined, checkRedis: async () => undefined },
    readinessTimeoutMs: 100, logger: false, phaseFour: { authentication, authorization, service, templateAssetMaxBytes: 1024 } });
  await app.ready(); return { app, getActiveImageContent };
};

describe("authenticated template image content route", () => {
  const apps: Array<ReturnType<typeof buildApi>> = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

  it("denies unauthenticated, missing-tenant, foreign-tenant, and permissionless requests", async () => {
    const unauthenticated = await createApp(null); apps.push(unauthenticated.app);
    expect((await unauthenticated.app.inject({ method: "GET", url: `/api/admin/templates/${templateId}/assets/${assetId}/content`, headers: { "x-organization-id": organizationId } })).statusCode).toBe(401);

    const permitted = await createApp(contextFor(["template:read"])); apps.push(permitted.app);
    expect((await permitted.app.inject({ method: "GET", url: `/api/admin/templates/${templateId}/assets/${assetId}/content` })).statusCode).toBe(400);
    expect((await permitted.app.inject({ method: "GET", url: `/api/admin/templates/${templateId}/assets/${assetId}/content`, headers: { "x-organization-id": "20000000-0000-4000-8000-000000000001" } })).statusCode).toBe(403);

    const permissionless = await createApp(contextFor([])); apps.push(permissionless.app);
    expect((await permissionless.app.inject({ method: "GET", url: `/api/admin/templates/${templateId}/assets/${assetId}/content`, headers: { "x-organization-id": organizationId } })).statusCode).toBe(403);
  });

  it("rejects malformed IDs before storage and returns bounded image headers only for an authorized request", async () => {
    const result = await createApp(contextFor(["template:read"])); apps.push(result.app);
    expect((await result.app.inject({ method: "GET", url: `/api/admin/templates/not-a-uuid/assets/${assetId}/content`, headers: { "x-organization-id": organizationId } })).statusCode).toBe(400);
    expect(result.getActiveImageContent).not.toHaveBeenCalled();

    const response = await result.app.inject({ method: "GET", url: `/api/admin/templates/${templateId}/assets/${assetId}/content`, headers: { "x-organization-id": organizationId } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/png");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(response.headers["content-length"]).toBe("4");
    expect(response.body).not.toContain("template-assets/");
    expect(result.getActiveImageContent).toHaveBeenCalledWith(organizationId, templateId, assetId, 1024);
  });
});
