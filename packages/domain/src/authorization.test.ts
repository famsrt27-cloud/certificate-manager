import { describe, expect, it } from "vitest";

import { authorizeOrganizationPermission, createAuthorizationVersion, type EffectiveIdentity } from "./authorization.js";

const identity: EffectiveIdentity = {
  user: { id: "user-1", email: "synthetic@example.invalid" },
  systemRoles: [],
  memberships: [{
    id: "membership-a",
    organizationId: "organization-a",
    organizationName: "Synthetic A",
    roles: ["VIEWER"],
    permissions: ["project:read"]
  }]
};

describe("organization authorization", () => {
  it("does not allow a permission from one tenant to authorize another tenant", () => {
    expect(authorizeOrganizationPermission(identity, "organization-b", "project:read")).toEqual({
      allowed: false,
      reason: "NO_ACTIVE_MEMBERSHIP"
    });
  });

  it("rejects privilege escalation when a membership lacks the server-resolved permission", () => {
    expect(authorizeOrganizationPermission(identity, "organization-a", "project:update")).toEqual({
      allowed: false,
      reason: "MISSING_PERMISSION"
    });
  });

  it("allows SUPER_ADMIN only through an explicit reviewed bypass", () => {
    const superAdmin = { ...identity, systemRoles: ["SUPER_ADMIN"] };

    expect(authorizeOrganizationPermission(superAdmin, "organization-b", "security:read").allowed).toBe(false);
    expect(authorizeOrganizationPermission(superAdmin, "organization-b", "security:read", true)).toMatchObject({
      allowed: true,
      superAdmin: true
    });
  });

  it("changes the authorization version when a server-side role assignment changes", () => {
    const before = createAuthorizationVersion(identity);
    const after = createAuthorizationVersion({
      ...identity,
      memberships: [{ ...identity.memberships[0]!, roles: ["ORG_ADMIN"] }]
    });

    expect(after).not.toBe(before);
  });
});
