import { hashPassword, LoginRateLimiter, MfaSecretCipher, RedisMfaChallengeStore, RedisSessionStore,
  totpForTimestep, verifyRecoveryCode, type SessionRedisStore } from "@certificate-platform/auth";
import { AuthenticationResponseSchema, ErrorResponseSchema, LoginResponseSchema, LogoutResponseSchema,
  MfaCompletionResponseSchema } from "@certificate-platform/contracts";
import type { AuditEvent, EffectiveIdentity } from "@certificate-platform/domain";
import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { buildApi } from "../app.js";
import { AuthenticationService, type IdentityProvider } from "../modules/auth/authentication-service.js";

class MemoryAuthRedis implements SessionRedisStore {
  readonly values = new Map<string, string>();
  readonly counters = new Map<string, number>();
  fail = false;
  async get(key: string): Promise<string | null> { if (this.fail) throw new Error("secret Redis detail"); return this.values.get(key) ?? null; }
  async getAndDelete(key: string): Promise<string | null> {
    if (this.fail) throw new Error("secret Redis detail");
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  }
  async setWithExpiry(key: string, value: string): Promise<void> { if (this.fail) throw new Error("secret Redis detail"); this.values.set(key, value); }
  async setWithExpiryIfExists(key: string, value: string): Promise<boolean> {
    if (this.fail) throw new Error("secret Redis detail");
    if (!this.values.has(key)) return false;
    this.values.set(key, value);
    return true;
  }
  async delete(key: string): Promise<void> { if (this.fail) throw new Error("secret Redis detail"); this.values.delete(key); this.counters.delete(key); }
  async incrementWithExpiry(key: string): Promise<{ count: number; ttlSeconds: number }> {
    if (this.fail) throw new Error("secret Redis detail");
    const count = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, count);
    return { count, ttlSeconds: 900 };
  }
}

const userId = "00000000-0000-4000-8000-000000000001";
const membershipId = "00000000-0000-4000-8000-000000000002";
const organizationId = "00000000-0000-4000-8000-000000000003";
let passwordHash = "";
let dummyPasswordHash = "";

beforeAll(async () => {
  passwordHash = await hashPassword("synthetic-password", 12);
  dummyPasswordHash = await hashPassword("constant-dummy-password", 12);
});

const buildFixture = (accountMaximum = 5, passwordVerifier?: (password: string, hash: string) => Promise<boolean>, mfaRequired = false) => {
  const redis = new MemoryAuthRedis();
  const auditEvents: AuditEvent[] = [];
  let identity: EffectiveIdentity | null = {
    user: { id: userId, email: "admin@example.invalid" },
    systemRoles: [],
    memberships: [{
      id: membershipId,
      organizationId,
      organizationName: "Synthetic Organization",
      roles: ["ORG_ADMIN"],
      permissions: ["organization:read", "role:assign"]
    }]
  };
  let userStatus: "ACTIVE" | "INACTIVE" | "ARCHIVED" = "ACTIVE";
  let now = 1_800_000_000_000;
  let factor: { encryptedTotpSecret: string; recoveryCodeHashes: readonly string[]; lastAcceptedTimestep: number | null } | null = null;
  const identities: IdentityProvider = {
    findByNormalizedEmail: vi.fn(async (email: string) => email === "admin@example.invalid" ? {
      id: userId,
      email,
      passwordHash,
      status: userStatus
    } : null),
    loadEffectiveIdentity: vi.fn(async () => identity)
  };
  let tokenCounter = 0;
  const sessions = new RedisSessionStore({
    redis,
    configuration: { secret: "s".repeat(32), idleTtlSeconds: 1_800, absoluteTtlSeconds: 28_800 },
    randomToken: () => Buffer.alloc(32, ++tokenCounter).toString("base64url")
  });
  const service = new AuthenticationService({
    sessions,
    rateLimiter: new LoginRateLimiter(redis, {
      secret: "s".repeat(32),
      windowSeconds: 900,
      accountMaximum,
      networkMaximum: 20
    }),
    identities,
    audit: { write: async (event) => { auditEvents.push(event); } },
    allowedOrigins: ["https://admin.example.invalid"],
    dummyPasswordHash,
    ...(mfaRequired ? {
      mfaPolicy: "REQUIRED" as const,
      mfaCipher: new MfaSecretCipher(Buffer.alloc(32, 9)),
      mfaChallenges: new RedisMfaChallengeStore(redis, Buffer.alloc(32, 9)),
      mfaFactors: {
        find: async () => factor,
        enroll: async (_userId: string, encryptedTotpSecret: string, recoveryCodeHashes: readonly string[], timestep: number) => {
          if (factor !== null) return false;
          factor = { encryptedTotpSecret, recoveryCodeHashes, lastAcceptedTimestep: timestep };
          return true;
        },
        acceptTimestep: async (_userId: string, timestep: number) => {
          if (factor === null || (factor.lastAcceptedTimestep !== null && factor.lastAcceptedTimestep >= timestep)) return false;
          factor = { ...factor, lastAcceptedTimestep: timestep };
          return true;
        },
        consumeRecoveryHash: async (_userId: string, hash: string) => {
          if (factor === null || !factor.recoveryCodeHashes.includes(hash)) return false;
          factor = { ...factor, recoveryCodeHashes: factor.recoveryCodeHashes.filter((candidate) => candidate !== hash) };
          return true;
        }
      },
      now: () => now
    } : {}),
    ...(passwordVerifier === undefined ? {} : { passwordVerifier })
  });
  const app = buildApi({
    dependencies: {
      checkDatabase: vi.fn().mockResolvedValue(undefined),
      checkRedis: vi.fn().mockResolvedValue(undefined)
    },
    readinessTimeoutMs: 100,
    logger: false,
    authentication: { service, absoluteTtlSeconds: 28_800 }
  });
  return { app, redis, auditEvents, identities,
    getFactor: () => factor,
    advanceTime: (milliseconds: number) => { now += milliseconds; },
    setIdentity: (value: EffectiveIdentity | null) => { identity = value; },
    setUserStatus: (value: "ACTIVE" | "INACTIVE" | "ARCHIVED") => { userStatus = value; } };
};

const login = (app: ReturnType<typeof buildApi>, password = "synthetic-password", cookie?: string) => {
  let operation = request(app.server)
    .post("/api/admin/auth/login")
    .set("origin", "https://admin.example.invalid")
    .send({ email: "admin@example.invalid", password });
  if (cookie !== undefined) operation = operation.set("cookie", cookie);
  return operation;
};

const cookiePair = (response: request.Response): string => {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") throw new Error("missing cookie");
  return value.split(";")[0]!;
};

describe("admin authentication routes", () => {
  it("requires MFA after password, enrolls TOTP, rejects replay, and consumes a recovery code once", async () => {
    const fixture = buildFixture(5, undefined, true);
    await fixture.app.ready();

    const passwordOnly = await login(fixture.app);
    const pending = LoginResponseSchema.parse(passwordOnly.body);
    expect(pending.data).toMatchObject({ status: "MFA_ENROLLMENT_REQUIRED" });
    expect(String(passwordOnly.headers["set-cookie"])).not.toMatch(/__Host-admin_session=[A-Za-z0-9_-]{43}/);
    expect((await request(fixture.app.server).get("/api/admin/auth/session").set("cookie", cookiePair(passwordOnly))).status).toBe(401);

    if (!("status" in pending.data) || pending.data.status !== "MFA_ENROLLMENT_REQUIRED") throw new Error("expected enrollment");
    const secret = new URL(pending.data.provisioning_uri).searchParams.get("secret");
    if (secret === null) throw new Error("missing enrollment secret");
    expect([...fixture.redis.values.values()].join(";")).not.toContain(secret);
    const timestep = Math.floor(1_800_000_000_000 / 30_000);
    const validCode = totpForTimestep(secret, timestep);
    const acceptedCodes = new Set([-1, 0, 1].map((offset) => totpForTimestep(secret, timestep + offset)));
    let invalidCode = "000000";
    while (acceptedCodes.has(invalidCode)) invalidCode = (Number(invalidCode) + 1).toString().padStart(6, "0");
    const invalid = await request(fixture.app.server).post("/api/admin/auth/mfa")
      .set("origin", "https://admin.example.invalid").set("cookie", cookiePair(passwordOnly))
      .send({ code: invalidCode });
    expect(invalid.status).toBe(401);
    const enrolled = await request(fixture.app.server).post("/api/admin/auth/mfa")
      .set("origin", "https://admin.example.invalid").set("cookie", cookiePair(passwordOnly))
      .send({ code: validCode });
    expect(enrolled.status).toBe(200);
    const completed = MfaCompletionResponseSchema.parse(enrolled.body);
    const recoveryCode = completed.data.recovery_codes?.[0];
    const secondRecoveryCode = completed.data.recovery_codes?.[1];
    const thirdRecoveryCode = completed.data.recovery_codes?.[2];
    expect(recoveryCode).toBeDefined();
    expect(secondRecoveryCode).toBeDefined();
    expect(thirdRecoveryCode).toBeDefined();
    expect(JSON.stringify(enrolled.body)).not.toContain(secret);
    expect(fixture.getFactor()?.encryptedTotpSecret).not.toContain(secret);
    expect(await verifyRecoveryCode(recoveryCode!, fixture.getFactor()!.recoveryCodeHashes[0]!)).toBe(true);
    expect([...fixture.redis.values.values()].join(";")).not.toContain(recoveryCode);

    const replayChallenge = await login(fixture.app);
    const replay = await request(fixture.app.server).post("/api/admin/auth/mfa")
      .set("origin", "https://admin.example.invalid").set("cookie", cookiePair(replayChallenge))
      .send({ code: validCode });
    expect(replay.status).toBe(401);

    const recoveryChallenge = await login(fixture.app);
    const recovered = await request(fixture.app.server).post("/api/admin/auth/mfa")
      .set("origin", "https://admin.example.invalid").set("cookie", cookiePair(recoveryChallenge))
      .send({ code: recoveryCode });
    expect(recovered.status).toBe(200);
    const reusedChallenge = await login(fixture.app);
    const reused = await request(fixture.app.server).post("/api/admin/auth/mfa")
      .set("origin", "https://admin.example.invalid").set("cookie", cookiePair(reusedChallenge))
      .send({ code: recoveryCode });
    expect(reused.status).toBe(401);

    const concurrentChallenge = await login(fixture.app);
    const concurrentCookie = cookiePair(concurrentChallenge);
    const concurrent = await Promise.all([secondRecoveryCode!, thirdRecoveryCode!].map((code) =>
      request(fixture.app.server).post("/api/admin/auth/mfa")
        .set("origin", "https://admin.example.invalid").set("cookie", concurrentCookie)
        .send({ code })
    ));
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 401]);
    expect(JSON.stringify(fixture.auditEvents)).not.toContain(recoveryCode);
    await fixture.app.close();
  }, 15_000);

  it("logs in, sets the canonical hardened cookie and inspects only authorized memberships", async () => {
    const fixture = buildFixture();
    await fixture.app.ready();

    const response = await login(fixture.app);
    const body = AuthenticationResponseSchema.parse(response.body);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["set-cookie"]?.[0]).toContain("__Host-admin_session=");
    expect(response.headers["set-cookie"]?.[0]).toContain("Secure");
    expect(response.headers["set-cookie"]?.[0]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]?.[0]).toContain("SameSite=Lax");
    expect(response.headers["set-cookie"]?.[0]).not.toContain("Domain=");
    expect(body.data.memberships[0]?.organization.id).toBe(organizationId);
    expect(JSON.stringify(body)).not.toContain("passwordHash");

    const inspected = await request(fixture.app.server)
      .get("/api/admin/auth/session")
      .set("cookie", cookiePair(response));
    expect(inspected.status).toBe(200);
    expect(AuthenticationResponseSchema.parse(inspected.body).data.csrf_token).toBe(body.data.csrf_token);
    await fixture.app.close();
  });

  it("uses the same generic error for wrong-password and unknown-account failures", async () => {
    const fixture = buildFixture();
    await fixture.app.ready();

    const known = await login(fixture.app, "wrong-password");
    const unknown = await request(fixture.app.server)
      .post("/api/admin/auth/login")
      .set("origin", "https://admin.example.invalid")
      .send({ email: "unknown@example.invalid", password: "wrong-password" });

    expect(known.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(ErrorResponseSchema.parse(known.body).error).toEqual(ErrorResponseSchema.parse(unknown.body).error);
    expect(fixture.auditEvents.every((event) => JSON.stringify(event).includes("example.invalid") === false)).toBe(true);
    await fixture.app.close();
  });

  it("performs password verification for unknown and inactive accounts without changing the generic response", async () => {
    const passwordVerifier = vi.fn(async (_password: string, hash: string) => hash === passwordHash);
    const fixture = buildFixture(5, passwordVerifier);
    await fixture.app.ready();

    const unknown = await request(fixture.app.server)
      .post("/api/admin/auth/login")
      .set("origin", "https://admin.example.invalid")
      .send({ email: "unknown@example.invalid", password: "synthetic-password" });
    fixture.setUserStatus("INACTIVE");
    const inactive = await login(fixture.app);

    expect(unknown.status).toBe(401);
    expect(inactive.status).toBe(401);
    expect(ErrorResponseSchema.parse(unknown.body).error).toEqual(ErrorResponseSchema.parse(inactive.body).error);
    expect(passwordVerifier).toHaveBeenNthCalledWith(1, "synthetic-password", dummyPasswordHash);
    expect(passwordVerifier).toHaveBeenNthCalledWith(2, "synthetic-password", passwordHash);
    await fixture.app.close();
  });

  it("enforces allowed Origin and distributed throttling before successful authentication", async () => {
    const fixture = buildFixture(1);
    await fixture.app.ready();

    const noOrigin = await request(fixture.app.server)
      .post("/api/admin/auth/login")
      .send({ email: "admin@example.invalid", password: "synthetic-password" });
    const first = await login(fixture.app, "wrong-password");
    const limited = await login(fixture.app, "wrong-password");

    expect(noOrigin.status).toBe(403);
    expect(first.status).toBe(401);
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBe("900");
    expect(limited.headers["cache-control"]).toBe("no-store");
    const rateLimitAuditCount = fixture.auditEvents.filter((event) =>
      event.action === "AUTH_LOGIN_FAILED" && event.metadata?.reason === "RATE_LIMITED").length;
    for (let index = 0; index < 5; index += 1) await login(fixture.app, "wrong-password");
    expect(fixture.auditEvents.filter((event) =>
      event.action === "AUTH_LOGIN_FAILED" && event.metadata?.reason === "RATE_LIMITED")).toHaveLength(rateLimitAuditCount);
    await fixture.app.close();
  });

  it.each([
    undefined,
    "https://admin.example.invalid.evil.invalid",
    "https://sub.admin.example.invalid",
    "http://admin.example.invalid",
    "https://admin.example.invalid:444",
    "https://admin.example.invalid/path"
  ])("rejects missing or confused login Origin %s", async (origin) => {
    const fixture = buildFixture();
    await fixture.app.ready();
    let operation = request(fixture.app.server).post("/api/admin/auth/login")
      .send({ email: "admin@example.invalid", password: "synthetic-password" });
    if (origin !== undefined) operation = operation.set("origin", origin);

    expect((await operation).status).toBe(403);
    expect(fixture.identities.findByNormalizedEmail).not.toHaveBeenCalled();
    await fixture.app.close();
  });

  it("replaces a deterministic attacker-known stale session cookie on login", async () => {
    const fixture = buildFixture();
    await fixture.app.ready();
    const attackerSession = "z".repeat(43);

    const authenticated = await login(fixture.app, "synthetic-password",
      `__Host-admin_session=${attackerSession}`);

    expect(authenticated.status).toBe(200);
    expect(cookiePair(authenticated)).not.toBe(`__Host-admin_session=${attackerSession}`);
    expect((await request(fixture.app.server).get("/api/admin/auth/session")
      .set("cookie", `__Host-admin_session=${attackerSession}`)).status).toBe(401);
    await fixture.app.close();
  });

  it("rotates a supplied session and rejects the old cookie and old CSRF token", async () => {
    const fixture = buildFixture();
    await fixture.app.ready();

    const first = await login(fixture.app);
    const firstBody = AuthenticationResponseSchema.parse(first.body);
    const firstCookie = cookiePair(first);
    const second = await login(fixture.app, "synthetic-password", firstCookie);
    const secondBody = AuthenticationResponseSchema.parse(second.body);
    const secondCookie = cookiePair(second);

    expect(secondCookie).not.toBe(firstCookie);
    expect(secondBody.data.csrf_token).not.toBe(firstBody.data.csrf_token);
    expect((await request(fixture.app.server).get("/api/admin/auth/session").set("cookie", firstCookie)).status).toBe(401);
    expect((await request(fixture.app.server)
      .post("/api/admin/auth/logout")
      .set("origin", "https://admin.example.invalid")
      .set("cookie", secondCookie)
      .set("x-csrf-token", firstBody.data.csrf_token)).status).toBe(403);
    await fixture.app.close();
  });

  it("requires CSRF for logout, revokes the session and makes repeated logout safe", async () => {
    const fixture = buildFixture();
    await fixture.app.ready();
    const authenticated = await login(fixture.app);
    const body = AuthenticationResponseSchema.parse(authenticated.body);
    const cookie = cookiePair(authenticated);

    const missing = await request(fixture.app.server)
      .post("/api/admin/auth/logout")
      .set("origin", "https://admin.example.invalid")
      .set("cookie", cookie);
    const loggedOut = await request(fixture.app.server)
      .post("/api/admin/auth/logout")
      .set("origin", "https://admin.example.invalid")
      .set("cookie", cookie)
      .set("x-csrf-token", body.data.csrf_token);
    const repeated = await request(fixture.app.server)
      .post("/api/admin/auth/logout")
      .set("origin", "https://admin.example.invalid");

    expect(missing.status).toBe(403);
    expect(loggedOut.status).toBe(200);
    expect(LogoutResponseSchema.parse(loggedOut.body).data.logged_out).toBe(true);
    expect((await request(fixture.app.server).get("/api/admin/auth/session").set("cookie", cookie)).status).toBe(401);
    expect(repeated.status).toBe(200);
    await fixture.app.close();
  });

  it("rejects malformed, random, cross-session, and wrong-Origin CSRF attempts before logout mutation", async () => {
    const fixture = buildFixture();
    await fixture.app.ready();
    const first = await login(fixture.app);
    const second = await login(fixture.app);
    const firstBody = AuthenticationResponseSchema.parse(first.body);
    const secondBody = AuthenticationResponseSchema.parse(second.body);
    const firstCookie = cookiePair(first);
    const attempts = [
      { origin: "https://admin.example.invalid", token: "malformed" },
      { origin: "https://admin.example.invalid", token: "r".repeat(43) },
      { origin: "https://admin.example.invalid", token: secondBody.data.csrf_token },
      { origin: "https://admin.example.invalid.evil.invalid", token: firstBody.data.csrf_token },
      { origin: "http://admin.example.invalid", token: firstBody.data.csrf_token },
      { origin: "https://admin.example.invalid:444", token: firstBody.data.csrf_token }
    ];

    for (const attempt of attempts) {
      const response = await request(fixture.app.server).post("/api/admin/auth/logout")
        .set("origin", attempt.origin).set("cookie", firstCookie).set("x-csrf-token", attempt.token);
      expect(response.status).toBe(403);
      expect((await request(fixture.app.server).get("/api/admin/auth/session").set("cookie", firstCookie)).status).toBe(200);
    }
    await fixture.app.close();
  });

  it("does not restore authority when a valid CSRF token is replayed after logout", async () => {
    const fixture = buildFixture();
    await fixture.app.ready();
    const authenticated = await login(fixture.app);
    const body = AuthenticationResponseSchema.parse(authenticated.body);
    const cookie = cookiePair(authenticated);
    const logout = () => request(fixture.app.server).post("/api/admin/auth/logout")
      .set("origin", "https://admin.example.invalid").set("cookie", cookie)
      .set("x-csrf-token", body.data.csrf_token);

    expect((await logout()).status).toBe(200);
    expect((await logout()).status).toBe(200);
    expect((await request(fixture.app.server).get("/api/admin/auth/session").set("cookie", cookie)).status).toBe(401);
    await fixture.app.close();
  });

  it("revokes a stale session immediately after a server-side membership or role change", async () => {
    const fixture = buildFixture();
    await fixture.app.ready();
    const authenticated = await login(fixture.app);
    const cookie = cookiePair(authenticated);
    fixture.setIdentity({
      user: { id: userId, email: "admin@example.invalid" },
      systemRoles: [],
      memberships: []
    });

    const response = await request(fixture.app.server).get("/api/admin/auth/session").set("cookie", cookie);

    expect(response.status).toBe(401);
    expect(fixture.auditEvents.some((event) => event.action === "AUTH_SESSION_REVOKED"
      && event.metadata?.reason === "AUTHORIZATION_CHANGED")).toBe(true);
    await fixture.app.close();
  });

  it("revokes a stale session when the server-side user becomes disabled", async () => {
    const fixture = buildFixture();
    await fixture.app.ready();
    const authenticated = await login(fixture.app);
    const cookie = cookiePair(authenticated);
    fixture.setIdentity(null);

    const response = await request(fixture.app.server).get("/api/admin/auth/session").set("cookie", cookie);

    expect(response.status).toBe(401);
    expect(fixture.auditEvents.some((event) => event.action === "AUTH_SESSION_REVOKED"
      && event.metadata?.reason === "USER_INACTIVE")).toBe(true);
    await fixture.app.close();
  });

  it("fails closed with a safe response when Redis authentication state is unavailable", async () => {
    const fixture = buildFixture();
    fixture.redis.fail = true;
    await fixture.app.ready();

    const response = await login(fixture.app);

    expect(response.status).toBe(503);
    expect(ErrorResponseSchema.parse(response.body).error.code).toBe("SERVICE_UNAVAILABLE");
    expect(JSON.stringify(response.body)).not.toContain("secret Redis detail");
    await fixture.app.close();
  });

  it("maps malformed login JSON to a safe validation error", async () => {
    const fixture = buildFixture();
    await fixture.app.ready();

    const response = await request(fixture.app.server)
      .post("/api/admin/auth/login")
      .set("origin", "https://admin.example.invalid")
      .set("content-type", "application/json")
      .send("{not-json");

    expect(response.status).toBe(400);
    expect(ErrorResponseSchema.parse(response.body).error).toEqual({
      code: "VALIDATION_FAILED",
      message: "The request could not be processed."
    });
    expect(JSON.stringify(response.body)).not.toContain("not-json");
    await fixture.app.close();
  });
});
