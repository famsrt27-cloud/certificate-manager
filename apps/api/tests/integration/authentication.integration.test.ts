import { randomUUID } from "node:crypto";

import { hashPassword, LoginRateLimiter, RedisSessionStore } from "@certificate-platform/auth";
import {
  closeDatabase,
  createDatabase,
  findAuthenticationUser,
  insertAuditRecord,
  loadEffectiveIdentity
} from "@certificate-platform/database";
import { closeRedis, connectRedis, createRedisConnection } from "@certificate-platform/queue";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApi } from "../../src/app.js";
import { createAuthRedisStore } from "../../src/infrastructure/auth-redis-store.js";
import { AuthenticationService } from "../../src/modules/auth/authentication-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const integrationEnabled = databaseUrl !== undefined
  && redisUrl !== undefined
  && new URL(databaseUrl).pathname.toLowerCase().includes("test");

describe.skipIf(!integrationEnabled)("PostgreSQL and Redis authentication integration", () => {
  const namespace = `test:auth:${randomUUID()}:`;
  const userId = randomUUID();
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const membershipId = randomUUID();
  const email = `admin-${randomUUID()}@example.invalid`;
  const redis = createRedisConnection({ url: redisUrl!, connectionName: namespace });
  const database = createDatabase({ connectionString: databaseUrl!, maxConnections: 2 });
  let app: ReturnType<typeof buildApi>;

  beforeAll(async () => {
    await connectRedis(redis);
    const passwordHash = await hashPassword("synthetic-integration-password", 12);
    await database.insertInto("users").values({ id: userId, email, password_hash: passwordHash }).execute();
    await database.insertInto("organizations").values([
      { id: organizationId, name: "Synthetic Integration A" },
      { id: otherOrganizationId, name: "Synthetic Integration B" }
    ]).execute();
    await database.insertInto("organization_memberships").values({
      id: membershipId,
      organization_id: organizationId,
      user_id: userId
    }).execute();
    await database.insertInto("membership_roles").values({
      membership_id: membershipId,
      organization_id: organizationId,
      role: "ORG_ADMIN",
      granted_by_user_id: userId
    }).execute();

    const authRedis = createAuthRedisStore(redis);
    const service = new AuthenticationService({
      sessions: new RedisSessionStore({
        redis: authRedis,
        configuration: {
          secret: "integration-session-secret-value-32-bytes",
          idleTtlSeconds: 300,
          absoluteTtlSeconds: 1_800,
          keyPrefix: `${namespace}session:`
        }
      }),
      rateLimiter: new LoginRateLimiter(authRedis, {
        secret: "integration-session-secret-value-32-bytes",
        windowSeconds: 60,
        accountMaximum: 5,
        networkMaximum: 20,
        keyPrefix: `${namespace}rate:`
      }),
      allowedOrigins: ["https://admin.example.invalid"],
      dummyPasswordHash: passwordHash,
      identities: {
        findByNormalizedEmail: (normalizedEmail) => findAuthenticationUser(database, normalizedEmail),
        loadEffectiveIdentity: (resolvedUserId) => loadEffectiveIdentity(database, resolvedUserId)
      },
      audit: {
        write: (event) => insertAuditRecord(database, {
          organizationId: event.organizationId,
          actorUserId: event.actorUserId,
          actorMembershipId: event.actorMembershipId,
          action: event.action,
          resourceType: event.resourceType,
          resourceId: event.resourceId,
          requestId: event.requestId,
          metadata: event.metadata
        })
      }
    });
    app = buildApi({
      dependencies: { checkDatabase: async () => undefined, checkRedis: async () => undefined },
      readinessTimeoutMs: 100,
      logger: false,
      authentication: { service, absoluteTtlSeconds: 1_800 }
    });
    await app.ready();
  });

  afterAll(async () => {
    if (app !== undefined) await app.close();
    const keys = await redis.keys(`${namespace}*`);
    if (keys.length > 0) await redis.del(...keys);
    await Promise.all([closeDatabase(database), closeRedis(redis)]);
  });

  it("uses real RBAC assignments, Redis session state and revokes stale authorization", async () => {
    const loggedIn = await request(app.server)
      .post("/api/admin/auth/login")
      .set("origin", "https://admin.example.invalid")
      .send({ email, password: "synthetic-integration-password" });
    expect(loggedIn.status).toBe(200);
    expect(loggedIn.body.data.memberships[0].permissions).toContain("role:assign");
    const setCookie = loggedIn.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0];
    expect(cookie).toBeTypeOf("string");
    const sessionKeys = await redis.keys(`${namespace}session:*`);
    expect(sessionKeys).toHaveLength(1);
    expect(await redis.ttl(sessionKeys[0]!)).toBeGreaterThan(0);
    expect(await redis.ttl(sessionKeys[0]!)).toBeLessThanOrEqual(300);

    await database.updateTable("organization_memberships")
      .set({ status: "INACTIVE" })
      .where("id", "=", membershipId)
      .execute();

    const stale = await request(app.server).get("/api/admin/auth/session").set("cookie", cookie!);
    expect(stale.status).toBe(401);
    const audit = await database.selectFrom("audit_logs")
      .select(["action", "metadata"])
      .where("actor_user_id", "=", userId)
      .where("action", "=", "AUTH_SESSION_REVOKED")
      .executeTakeFirst();
    expect(audit?.action).toBe("AUTH_SESSION_REVOKED");
  });

  it("lets PostgreSQL reject a cross-tenant membership-role assignment", async () => {
    await expect(database.insertInto("membership_roles").values({
      membership_id: membershipId,
      organization_id: otherOrganizationId,
      role: "VIEWER",
      granted_by_user_id: userId
    }).execute()).rejects.toThrow();
  });

  it("lets PostgreSQL reject SUPER_ADMIN as an organization membership role", async () => {
    await expect(database.insertInto("membership_roles").values({
      membership_id: membershipId,
      organization_id: organizationId,
      role: "SUPER_ADMIN",
      granted_by_user_id: userId
    }).execute()).rejects.toThrow();
  });
});
