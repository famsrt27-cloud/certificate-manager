import { createHash } from "node:crypto";

export interface EffectiveMembership {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
}

export interface EffectiveIdentity {
  readonly user: {
    readonly id: string;
    readonly email: string;
  };
  readonly systemRoles: readonly string[];
  readonly memberships: readonly EffectiveMembership[];
}

export type AuthorizationDecision =
  | { readonly allowed: true; readonly membership: EffectiveMembership | null; readonly superAdmin: boolean }
  | { readonly allowed: false; readonly reason: "NO_ACTIVE_MEMBERSHIP" | "MISSING_PERMISSION" };

export const createAuthorizationVersion = (identity: EffectiveIdentity): string => {
  const stable = {
    userId: identity.user.id,
    systemRoles: [...identity.systemRoles].sort(),
    memberships: [...identity.memberships]
      .map((membership) => ({
        id: membership.id,
        organizationId: membership.organizationId,
        roles: [...membership.roles].sort(),
        permissions: [...membership.permissions].sort()
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
};

export const authorizeOrganizationPermission = (
  identity: EffectiveIdentity,
  organizationId: string,
  permission: string,
  allowSuperAdmin = false
): AuthorizationDecision => {
  if (allowSuperAdmin && identity.systemRoles.includes("SUPER_ADMIN")) {
    return { allowed: true, membership: null, superAdmin: true };
  }

  const membership = identity.memberships.find((candidate) => candidate.organizationId === organizationId);
  if (membership === undefined) return { allowed: false, reason: "NO_ACTIVE_MEMBERSHIP" };
  if (!membership.permissions.includes(permission)) return { allowed: false, reason: "MISSING_PERMISSION" };
  return { allowed: true, membership, superAdmin: false };
};
