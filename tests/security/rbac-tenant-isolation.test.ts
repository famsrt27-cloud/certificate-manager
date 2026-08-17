import type { EffectiveIdentity } from "@certificate-platform/domain";
import { describe, expect, it, vi } from "vitest";

import { ApplicationError } from "../../apps/api/src/errors/application-error.js";
import type { AuthenticatedContext, AuthenticationService } from "../../apps/api/src/modules/auth/authentication-service.js";
import { OrganizationAuthorizationService } from "../../apps/api/src/modules/auth/organization-authorization-service.js";

const identity: EffectiveIdentity = {
  user: { id: "00000000-0000-4000-8000-000000000001", email: "synthetic@example.invalid" },
  systemRoles: [],
  memberships: [{
    id: "00000000-0000-4000-8000-000000000002",
    organizationId: "00000000-0000-4000-8000-000000000003",
    organizationName: "Synthetic Tenant A",
    roles: ["VIEWER"],
    permissions: ["project:read"]
  }]
};

const authenticated = {
  sessionId: "s".repeat(43),
  session: {
    version: 1 as const,
    userId: identity.user.id,
    csrfToken: "c".repeat(43),
    authorizationVersion: "a".repeat(64),
    createdAt: 1,
    lastSeenAt: 1,
    absoluteExpiresAt: 2
  },
  identity
} satisfies AuthenticatedContext;

describe("Phase 2 RBAC abuse cases", () => {
  it("rejects a cross-tenant identifier before it can become query scope", async () => {
    const audit = vi.fn().mockResolvedValue(undefined);
    const authorization = new OrganizationAuthorizationService(
      { validateStateChangingRequest: vi.fn() } as unknown as AuthenticationService,
      { write: audit }
    );

    await expect(authorization.requirePermission({
      authenticated,
      organizationId: "00000000-0000-4000-8000-000000000004",
      permission: "project:read",
      requestId: "00000000-0000-4000-8000-000000000005",
      stateChanging: false
    })).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 } satisfies Partial<ApplicationError>);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: null,
      actorMembershipId: null,
      metadata: { reason: "NO_ACTIVE_MEMBERSHIP", permission: "project:read" }
    }));
  });

  it("checks CSRF before permission policy for state-changing operations", async () => {
    const csrfFailure = new ApplicationError("REQUEST_FORBIDDEN", "The request could not be authorized.", 403);
    const validateStateChangingRequest = vi.fn(() => { throw csrfFailure; });
    const audit = vi.fn().mockResolvedValue(undefined);
    const authorization = new OrganizationAuthorizationService(
      { validateStateChangingRequest } as unknown as AuthenticationService,
      { write: audit }
    );

    await expect(authorization.requirePermission({
      authenticated,
      organizationId: identity.memberships[0]!.organizationId,
      permission: "project:update",
      requestId: "00000000-0000-4000-8000-000000000005",
      stateChanging: true,
      origin: "https://admin.example.invalid",
      csrfToken: "forged"
    })).rejects.toBe(csrfFailure);
    expect(validateStateChangingRequest).toHaveBeenCalledOnce();
    expect(audit).not.toHaveBeenCalled();
  });

  it("ignores forged frontend permissions and uses only server-resolved membership permissions", async () => {
    const authorization = new OrganizationAuthorizationService(
      { validateStateChangingRequest: vi.fn() } as unknown as AuthenticationService,
      { write: vi.fn().mockResolvedValue(undefined) }
    );
    const forgedRequest = {
      authenticated,
      organizationId: identity.memberships[0]!.organizationId,
      permission: "project:update",
      requestId: "00000000-0000-4000-8000-000000000005",
      stateChanging: false,
      frontend_permissions: ["project:update"]
    };

    await expect(authorization.requirePermission(forgedRequest)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
