import { sql, type Transaction } from "kysely";

import type { DatabaseClient } from "./database.js";
import type { Database, RecordStatus } from "./types.js";

const BOOTSTRAP_LOCK_KEY = "certificate-platform:development-admin-bootstrap:v1";

export interface DevelopmentAdminBootstrapInput {
  readonly email: string;
  readonly organizationName: string;
  readonly passwordHash: string;
  readonly replaceExistingPassword: boolean;
}

export interface DevelopmentAdminBootstrapResult {
  readonly organization: "CREATED" | "EXISTING";
  readonly user: "CREATED" | "EXISTING";
  readonly password: "CREATED" | "UNCHANGED" | "UPDATED";
  readonly membership: "CREATED" | "EXISTING";
  readonly organizationAdminRole: "ASSIGNED" | "EXISTING";
}

const assertActive = (resource: string, status: RecordStatus): void => {
  if (status !== "ACTIVE") {
    throw new Error(`Existing ${resource} is not active; no destructive change was performed`);
  }
};

const findOrCreateOrganization = async (
  transaction: Transaction<Database>,
  organizationName: string
): Promise<{ readonly id: string; readonly state: "CREATED" | "EXISTING" }> => {
  const organizations = await transaction.selectFrom("organizations")
    .select(["id", "status"])
    .where(sql<string>`lower(name)`, "=", organizationName.toLowerCase())
    .limit(2)
    .execute();

  if (organizations.length > 1) {
    throw new Error("Multiple organizations match that name; no change was performed");
  }
  const existing = organizations[0];
  if (existing !== undefined) {
    assertActive("organization", existing.status);
    return { id: existing.id, state: "EXISTING" };
  }

  const created = await transaction.insertInto("organizations")
    .values({ name: organizationName })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: created.id, state: "CREATED" };
};

const findOrCreateUser = async (
  transaction: Transaction<Database>,
  input: Pick<DevelopmentAdminBootstrapInput, "email" | "passwordHash" | "replaceExistingPassword">
): Promise<{
  readonly id: string;
  readonly state: "CREATED" | "EXISTING";
  readonly password: "CREATED" | "UNCHANGED" | "UPDATED";
}> => {
  const existing = await transaction.selectFrom("users")
    .select(["id", "status"])
    .where(sql<string>`lower(email)`, "=", input.email)
    .executeTakeFirst();

  if (existing === undefined) {
    const created = await transaction.insertInto("users")
      .values({ email: input.email, password_hash: input.passwordHash })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { id: created.id, state: "CREATED", password: "CREATED" };
  }

  assertActive("user", existing.status);
  if (!input.replaceExistingPassword) {
    return { id: existing.id, state: "EXISTING", password: "UNCHANGED" };
  }
  await transaction.updateTable("users")
    .set({ password_hash: input.passwordHash, updated_at: new Date() })
    .where("id", "=", existing.id)
    .executeTakeFirstOrThrow();
  return { id: existing.id, state: "EXISTING", password: "UPDATED" };
};

const findOrCreateMembership = async (
  transaction: Transaction<Database>,
  organizationId: string,
  userId: string
): Promise<{ readonly id: string; readonly state: "CREATED" | "EXISTING" }> => {
  const existing = await transaction.selectFrom("organization_memberships")
    .select(["id", "status"])
    .where("organization_id", "=", organizationId)
    .where("user_id", "=", userId)
    .executeTakeFirst();

  if (existing !== undefined) {
    assertActive("organization membership", existing.status);
    return { id: existing.id, state: "EXISTING" };
  }

  const created = await transaction.insertInto("organization_memberships")
    .values({ organization_id: organizationId, user_id: userId })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: created.id, state: "CREATED" };
};

const assignOrganizationAdmin = async (
  transaction: Transaction<Database>,
  organizationId: string,
  membershipId: string,
  userId: string
): Promise<"ASSIGNED" | "EXISTING"> => {
  const role = await transaction.selectFrom("roles")
    .select(["code", "scope"])
    .where("code", "=", "ORG_ADMIN")
    .executeTakeFirst();
  if (role === undefined || role.scope !== "ORGANIZATION") {
    throw new Error("The ORG_ADMIN role is unavailable; run database migrations first");
  }

  const existing = await transaction.selectFrom("membership_roles")
    .select("role")
    .where("membership_id", "=", membershipId)
    .where("organization_id", "=", organizationId)
    .where("role", "=", "ORG_ADMIN")
    .executeTakeFirst();
  if (existing !== undefined) return "EXISTING";

  await transaction.insertInto("membership_roles").values({
    membership_id: membershipId,
    organization_id: organizationId,
    role: "ORG_ADMIN",
    granted_by_user_id: userId
  }).executeTakeFirstOrThrow();
  return "ASSIGNED";
};

export const bootstrapDevelopmentAdmin = async (
  database: DatabaseClient,
  input: DevelopmentAdminBootstrapInput
): Promise<DevelopmentAdminBootstrapResult> => database.transaction().execute(async (transaction) => {
  await sql`select pg_advisory_xact_lock(hashtext(${BOOTSTRAP_LOCK_KEY}))`.execute(transaction);

  const organization = await findOrCreateOrganization(transaction, input.organizationName);
  const user = await findOrCreateUser(transaction, input);
  const membership = await findOrCreateMembership(transaction, organization.id, user.id);
  const organizationAdminRole = await assignOrganizationAdmin(
    transaction,
    organization.id,
    membership.id,
    user.id
  );

  return {
    organization: organization.state,
    user: user.state,
    password: user.password,
    membership: membership.state,
    organizationAdminRole
  };
});
