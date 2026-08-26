import type { EffectiveIdentity } from "@certificate-platform/domain";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { buildApi } from "../../apps/api/src/app.js";
import { ApplicationError } from "../../apps/api/src/errors/application-error.js";
import type { AuthenticatedContext, AuthenticationService } from "../../apps/api/src/modules/auth/authentication-service.js";
import { OrganizationAuthorizationService } from "../../apps/api/src/modules/auth/organization-authorization-service.js";
import type { PhaseFiveService } from "../../apps/api/src/modules/phase-five/phase-five-service.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const otherOrganizationId = "00000000-0000-4000-8000-000000000002";
const trainingId = "00000000-0000-4000-8000-000000000003";
const versionId = "00000000-0000-4000-8000-000000000004";

const buildFixture = (permissions: readonly string[], roles: readonly string[] = ["VIEWER"]) => {
  const identity: EffectiveIdentity = {
    user: { id: "00000000-0000-4000-8000-000000000005", email: "synthetic@example.invalid" },
    systemRoles: [],
    memberships: [{
      id: "00000000-0000-4000-8000-000000000006",
      organizationId,
      organizationName: "Synthetic Tenant",
      roles,
      permissions
    }]
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
  const generate = vi.fn().mockResolvedValue({ job_id: "00000000-0000-4000-8000-000000000007", status: "QUEUED" });
  const service = { generate } as unknown as PhaseFiveService;
  const app = buildApi({
    dependencies: { checkDatabase: vi.fn(), checkRedis: vi.fn() },
    readinessTimeoutMs: 100,
    logger: false,
    phaseFive: {
      authentication,
      authorization: new OrganizationAuthorizationService(authentication, { write: vi.fn().mockResolvedValue(undefined) }),
      service
    }
  });
  return { app, generate };
};

const generateRequest = (app: ReturnType<typeof buildApi>, selectedOrganizationId = organizationId) =>
  request(app.server).post(`/api/admin/trainings/${trainingId}/certificates/generate`)
    .set("x-organization-id", selectedOrganizationId)
    .set("origin", "https://admin.example.invalid")
    .set("x-csrf-token", "c".repeat(43))
    .set("idempotency-key", "synthetic-generation-key")
    .send({ template_version_id: versionId });

describe("Phase 5 authorization abuse cases", () => {
  it("blocks template-only and role-name-collision memberships from certificate generation", async () => {
    for (const roles of [["TEMPLATE_MANAGER"], ["SUPER_ADMIN"]]) {
      const fixture = buildFixture(["template:read", "template:update"], roles);
      await fixture.app.ready();
      expect((await generateRequest(fixture.app)).status).toBe(403);
      expect(fixture.generate).not.toHaveBeenCalled();
      await fixture.app.close();
    }
  });

  it("blocks a foreign organization selector before generation service access", async () => {
    const fixture = buildFixture(["certificate:generate"]);
    await fixture.app.ready();
    expect((await generateRequest(fixture.app, otherOrganizationId)).status).toBe(403);
    expect(fixture.generate).not.toHaveBeenCalled();
    await fixture.app.close();
  });

  it("validates Origin and CSRF before generation service access", async () => {
    const fixture = buildFixture(["certificate:generate"]);
    await fixture.app.ready();
    const response = await generateRequest(fixture.app).unset("x-csrf-token");
    expect(response.status).toBe(403);
    expect(fixture.generate).not.toHaveBeenCalled();
    await fixture.app.close();
  });
});
