import { randomUUID } from "node:crypto";

import { hashPassword, verifyPassword } from "@certificate-platform/auth";
import { bootstrapDevelopmentAdmin, closeDatabase, createDatabase } from "@certificate-platform/database";
import { afterAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationEnabled = databaseUrl !== undefined
  && new URL(databaseUrl).pathname.toLowerCase().includes("test");

describe.skipIf(!integrationEnabled)("local development administrator bootstrap integration", () => {
  const suiteId = randomUUID();
  const email = `bootstrap-${suiteId}@example.invalid`;
  const organizationName = `Bootstrap Organization ${suiteId}`;
  const rollbackEmail = `bootstrap-rollback-${suiteId}@example.invalid`;
  const rollbackOrganizationName = `Bootstrap Rollback Organization ${suiteId}`;
  const database = createDatabase({ connectionString: databaseUrl!, maxConnections: 2 });

  afterAll(async () => {
    const users = await database.selectFrom("users").select("id").where("email", "in", [email, rollbackEmail]).execute();
    const userIds = users.map((user) => user.id);
    const memberships = userIds.length === 0 ? [] : await database.selectFrom("organization_memberships")
      .select("id")
      .where("user_id", "in", userIds)
      .execute();
    const membershipIds = memberships.map((membership) => membership.id);
    if (membershipIds.length > 0) {
      await database.deleteFrom("membership_roles").where("membership_id", "in", membershipIds).execute();
      await database.deleteFrom("organization_memberships").where("id", "in", membershipIds).execute();
    }
    if (userIds.length > 0) await database.deleteFrom("users").where("id", "in", userIds).execute();
    await database.deleteFrom("organizations").where("name", "in", [organizationName, rollbackOrganizationName]).execute();
    await closeDatabase(database);
  });

  it("creates a usable organization administrator without storing plaintext", async () => {
    const plaintextPassword = "synthetic-bootstrap-password";
    const passwordHash = await hashPassword(plaintextPassword, 12);

    const result = await bootstrapDevelopmentAdmin(database, {
      email,
      organizationName,
      passwordHash,
      replaceExistingPassword: false
    });

    expect(result).toEqual({
      organization: "CREATED",
      user: "CREATED",
      password: "CREATED",
      membership: "CREATED",
      organizationAdminRole: "ASSIGNED"
    });
    const created = await database.selectFrom("users as bootstrap_user")
      .innerJoin("organization_memberships as membership", "membership.user_id", "bootstrap_user.id")
      .innerJoin("organizations as organization", "organization.id", "membership.organization_id")
      .innerJoin("membership_roles as membership_role", (join) => join
        .onRef("membership_role.membership_id", "=", "membership.id")
        .onRef("membership_role.organization_id", "=", "organization.id"))
      .select(["bootstrap_user.password_hash", "membership_role.role"])
      .where("bootstrap_user.email", "=", email)
      .where("organization.name", "=", organizationName)
      .executeTakeFirstOrThrow();
    expect(created.password_hash).toMatch(/^\$2[aby]\$/);
    expect(created.password_hash).not.toBe(plaintextPassword);
    await expect(verifyPassword(plaintextPassword, created.password_hash)).resolves.toBe(true);
    expect(created.role).toBe("ORG_ADMIN");
  });

  it("is idempotent, leaves the password unchanged, and preserves unrelated roles", async () => {
    const existing = await database.selectFrom("users as bootstrap_user")
      .innerJoin("organization_memberships as membership", "membership.user_id", "bootstrap_user.id")
      .select(["bootstrap_user.id as user_id", "bootstrap_user.password_hash", "membership.id as membership_id", "membership.organization_id"])
      .where("bootstrap_user.email", "=", email)
      .executeTakeFirstOrThrow();
    await database.insertInto("membership_roles").values({
      membership_id: existing.membership_id,
      organization_id: existing.organization_id,
      role: "VIEWER",
      granted_by_user_id: existing.user_id
    }).execute();

    const differentHash = await hashPassword("different-synthetic-password", 12);
    const result = await bootstrapDevelopmentAdmin(database, {
      email,
      organizationName,
      passwordHash: differentHash,
      replaceExistingPassword: false
    });

    expect(result).toEqual({
      organization: "EXISTING",
      user: "EXISTING",
      password: "UNCHANGED",
      membership: "EXISTING",
      organizationAdminRole: "EXISTING"
    });
    const user = await database.selectFrom("users").select("password_hash").where("email", "=", email).executeTakeFirstOrThrow();
    expect(user.password_hash).toBe(existing.password_hash);
    const roles = await database.selectFrom("membership_roles")
      .select("role")
      .where("membership_id", "=", existing.membership_id)
      .orderBy("role")
      .execute();
    expect(roles.map((row) => row.role)).toEqual(["ORG_ADMIN", "VIEWER"]);
  });

  it("rolls back earlier inserts when a later write fails", async () => {
    await expect(bootstrapDevelopmentAdmin(database, {
      email: rollbackEmail,
      organizationName: rollbackOrganizationName,
      passwordHash: null as unknown as string,
      replaceExistingPassword: false
    })).rejects.toThrow();

    expect(await database.selectFrom("users").select("id").where("email", "=", rollbackEmail).executeTakeFirst()).toBeUndefined();
    expect(await database.selectFrom("organizations").select("id").where("name", "=", rollbackOrganizationName).executeTakeFirst()).toBeUndefined();
  });
});
