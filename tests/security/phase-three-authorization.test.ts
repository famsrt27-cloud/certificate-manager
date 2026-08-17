import type { EffectiveIdentity } from "@certificate-platform/domain";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { buildApi } from "../../apps/api/src/app.js";
import { ApplicationError } from "../../apps/api/src/errors/application-error.js";
import { OrganizationAuthorizationService } from "../../apps/api/src/modules/auth/organization-authorization-service.js";
import type { AuthenticatedContext, AuthenticationService } from "../../apps/api/src/modules/auth/authentication-service.js";
import type { PhaseThreeService } from "../../apps/api/src/modules/phase-three/phase-three-service.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const otherOrganizationId = "00000000-0000-4000-8000-000000000002";
const membershipId = "00000000-0000-4000-8000-000000000003";

const buildFixture = (permissions: readonly string[]) => {
  const identity: EffectiveIdentity = {
    user: { id: "00000000-0000-4000-8000-000000000004", email: "synthetic@example.invalid" },
    systemRoles: [],
    memberships: [{ id: membershipId, organizationId, organizationName: "Synthetic Tenant",
      roles: ["VIEWER"], permissions }]
  };
  const authenticated: AuthenticatedContext = {
    sessionId: "s".repeat(43),
    session: { version: 1, userId: identity.user.id, csrfToken: "c".repeat(43), authorizationVersion: "a".repeat(64),
      createdAt: 1, lastSeenAt: 1, absoluteExpiresAt: 2 },
    identity
  };
  const authentication = {
    authenticate: vi.fn().mockResolvedValue(authenticated),
    validateStateChangingRequest: vi.fn((_context, origin: string | undefined, csrfToken: string | undefined) => {
      if (origin !== "https://admin.example.invalid" || csrfToken !== "c".repeat(43)) {
        throw new ApplicationError("REQUEST_FORBIDDEN", "The request could not be authorized.", 403);
      }
    })
  } as unknown as AuthenticationService;
  const audit = { write: vi.fn().mockResolvedValue(undefined) };
  const service = {
    listProjects: vi.fn().mockResolvedValue({ data: [], nextCursor: null }),
    createProject: vi.fn().mockResolvedValue({ id: "00000000-0000-4000-8000-000000000005", name: "Safe Project",
      slug: "safe-project", status: "ACTIVE" })
  } as unknown as PhaseThreeService;
  const app = buildApi({ dependencies: { checkDatabase: vi.fn(), checkRedis: vi.fn() }, readinessTimeoutMs: 100,
    logger: false, phaseThree: { authentication, authorization: new OrganizationAuthorizationService(authentication, audit),
      service, participantImportMaxBytes: 1_024 } });
  return { app, authentication, audit, service: service as unknown as { listProjects: ReturnType<typeof vi.fn>;
    createProject: ReturnType<typeof vi.fn> } };
};

describe("Phase 3 authorization abuse cases", () => {
  it("uses a verified membership for the tenant selector and blocks cross-tenant UUID access", async () => {
    const fixture = buildFixture(["project:read"]);
    await fixture.app.ready();
    const allowed = await request(fixture.app.server).get("/api/admin/projects").set("x-organization-id", organizationId);
    const denied = await request(fixture.app.server).get("/api/admin/projects").set("x-organization-id", otherOrganizationId);
    expect(allowed.status).toBe(200);
    expect(denied.status).toBe(403);
    expect(fixture.service.listProjects).toHaveBeenCalledTimes(1);
    expect(fixture.audit.write).toHaveBeenCalledWith(expect.objectContaining({
      action: "AUTHORIZATION_DENIED", organizationId: null,
      metadata: { reason: "NO_ACTIVE_MEMBERSHIP", permission: "project:read" }
    }));
    await fixture.app.close();
  });

  it("rejects a VIEWER state change even with valid CSRF and ignores body/header claims", async () => {
    const fixture = buildFixture(["project:read"]);
    await fixture.app.ready();
    const response = await request(fixture.app.server).post("/api/admin/projects")
      .set("origin", "https://admin.example.invalid").set("x-csrf-token", "c".repeat(43))
      .set("x-organization-id", organizationId)
      .send({ name: "Forbidden Project", slug: "forbidden-project", permissions: ["project:create"] });
    expect(response.status).toBe(403);
    expect(fixture.service.createProject).not.toHaveBeenCalled();
    await fixture.app.close();
  });

  it("checks CSRF before domain mutation for an otherwise permitted request", async () => {
    const fixture = buildFixture(["project:create"]);
    await fixture.app.ready();
    const response = await request(fixture.app.server).post("/api/admin/projects")
      .set("origin", "https://admin.example.invalid").set("x-organization-id", organizationId)
      .send({ name: "Safe Project", slug: "safe-project" });
    expect(response.status).toBe(403);
    expect(fixture.service.createProject).not.toHaveBeenCalled();
    await fixture.app.close();
  });
});
