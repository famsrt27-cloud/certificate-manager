import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { Database, JsonValue, RecordStatus, RoleCode } from "./types.js";

export interface AuthenticationUserRecord {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly status: RecordStatus;
}

export interface AdminMfaFactorRecord {
  readonly encryptedTotpSecret: string;
  readonly recoveryCodeHashes: readonly string[];
  readonly lastAcceptedTimestep: number | null;
}

export const findAdminMfaFactor = async (
  database: Kysely<Database>,
  userId: string
): Promise<AdminMfaFactorRecord | null> => {
  const row = await database.selectFrom("admin_mfa_factors")
    .select(["encrypted_totp_secret", "recovery_code_hashes", "last_accepted_timestep"])
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    encryptedTotpSecret: row.encrypted_totp_secret,
    recoveryCodeHashes: row.recovery_code_hashes,
    lastAcceptedTimestep: row.last_accepted_timestep === null ? null : Number(row.last_accepted_timestep)
  };
};

export const enrollAdminMfaFactor = async (
  database: Kysely<Database>,
  userId: string,
  encryptedTotpSecret: string,
  recoveryCodeHashes: readonly string[],
  acceptedTimestep: number
): Promise<boolean> => {
  const result = await database.insertInto("admin_mfa_factors").values({
    user_id: userId,
    encrypted_totp_secret: encryptedTotpSecret,
    recovery_code_hashes: [...recoveryCodeHashes],
    last_accepted_timestep: String(acceptedTimestep)
  }).onConflict((conflict) => conflict.column("user_id").doNothing()).returning("user_id").executeTakeFirst();
  return result !== undefined;
};

export const acceptAdminMfaTimestep = async (
  database: Kysely<Database>,
  userId: string,
  timestep: number
): Promise<boolean> => {
  const result = await database.updateTable("admin_mfa_factors")
    .set({ last_accepted_timestep: String(timestep), updated_at: new Date() })
    .where("user_id", "=", userId)
    .where((expression) => expression.or([
      expression("last_accepted_timestep", "is", null),
      expression("last_accepted_timestep", "<", String(timestep))
    ]))
    .returning("user_id")
    .executeTakeFirst();
  return result !== undefined;
};

export const consumeAdminMfaRecoveryHash = async (
  database: Kysely<Database>,
  userId: string,
  recoveryHash: string
): Promise<boolean> => {
  const result = await database.updateTable("admin_mfa_factors")
    .set({
      recovery_code_hashes: sql<string[]>`array_remove(recovery_code_hashes, ${recoveryHash})`,
      updated_at: new Date()
    })
    .where("user_id", "=", userId)
    .where(sql<boolean>`${recoveryHash} = ANY(recovery_code_hashes)`)
    .returning("user_id")
    .executeTakeFirst();
  return result !== undefined;
};

export interface ResolvedMembershipRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly roles: readonly RoleCode[];
  readonly permissions: readonly string[];
}

export interface ResolvedIdentityRecord {
  readonly user: { readonly id: string; readonly email: string };
  readonly systemRoles: readonly RoleCode[];
  readonly memberships: readonly ResolvedMembershipRecord[];
}

export interface NewAuditRecord {
  readonly organizationId: string | null;
  readonly actorUserId: string | null;
  readonly actorMembershipId: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly requestId: string;
  readonly metadata: JsonValue | null;
}

export const findAuthenticationUser = async (
  database: Kysely<Database>,
  normalizedEmail: string
): Promise<AuthenticationUserRecord | null> => {
  const user = await database
    .selectFrom("users")
    .select(["id", "email", "password_hash", "status"])
    .where(sql<string>`lower(email)`, "=", normalizedEmail)
    .executeTakeFirst();

  return user === undefined ? null : {
    id: user.id,
    email: user.email,
    passwordHash: user.password_hash,
    status: user.status
  };
};

export const loadEffectiveIdentity = async (
  database: Kysely<Database>,
  userId: string
): Promise<ResolvedIdentityRecord | null> => {
  const user = await database
    .selectFrom("users")
    .select(["id", "email", "status"])
    .where("id", "=", userId)
    .executeTakeFirst();
  if (user === undefined || user.status !== "ACTIVE") return null;

  const memberships = await database
    .selectFrom("organization_memberships as membership")
    .innerJoin("organizations as organization", "organization.id", "membership.organization_id")
    .select([
      "membership.id as membership_id",
      "membership.organization_id",
      "organization.name as organization_name"
    ])
    .where("membership.user_id", "=", userId)
    .where("membership.status", "=", "ACTIVE")
    .where("organization.status", "=", "ACTIVE")
    .orderBy("membership.id")
    .execute();

  const membershipIds = memberships.map((membership) => membership.membership_id);
  const rolePermissionRows = membershipIds.length === 0 ? [] : await database
    .selectFrom("membership_roles as membership_role")
    .innerJoin("roles as role", "role.code", "membership_role.role")
    .leftJoin("role_permissions as role_permission", "role_permission.role", "role.code")
    .select([
      "membership_role.membership_id",
      "membership_role.organization_id",
      "membership_role.role",
      "role_permission.permission_code"
    ])
    .where("membership_role.membership_id", "in", membershipIds)
    .where("role.scope", "=", "ORGANIZATION")
    .orderBy("membership_role.role")
    .orderBy("role_permission.permission_code")
    .execute();

  const systemRoles = await database
    .selectFrom("user_system_roles as user_system_role")
    .innerJoin("roles as role", "role.code", "user_system_role.role")
    .select("user_system_role.role")
    .where("user_system_role.user_id", "=", userId)
    .where("role.scope", "=", "SYSTEM")
    .orderBy("user_system_role.role")
    .execute();

  return {
    user: { id: user.id, email: user.email },
    systemRoles: systemRoles.map((row) => row.role),
    memberships: memberships.map((membership) => {
      const rows = rolePermissionRows.filter((row) =>
        row.membership_id === membership.membership_id
        && row.organization_id === membership.organization_id
      );
      return {
        id: membership.membership_id,
        organizationId: membership.organization_id,
        organizationName: membership.organization_name,
        roles: [...new Set(rows.map((row) => row.role))],
        permissions: [...new Set(rows.flatMap((row) => row.permission_code === null ? [] : [row.permission_code]))]
      };
    })
  };
};

export const insertAuditRecord = async (
  database: Kysely<Database>,
  record: NewAuditRecord
): Promise<void> => {
  await database.insertInto("audit_logs").values({
    organization_id: record.organizationId,
    actor_user_id: record.actorUserId,
    actor_membership_id: record.actorMembershipId,
    action: record.action,
    resource_type: record.resourceType,
    resource_id: record.resourceId,
    request_id: record.requestId,
    metadata: record.metadata
  }).execute();
};
