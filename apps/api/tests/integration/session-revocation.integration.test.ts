import { randomUUID } from "node:crypto";

import { RedisSessionStore } from "@certificate-platform/auth";
import { closeRedis, connectRedis, createRedisConnection } from "@certificate-platform/queue";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAuthRedisStore } from "../../src/infrastructure/auth-redis-store.js";

const redisUrl = process.env.TEST_REDIS_URL;

describe.skipIf(redisUrl === undefined)("Redis session revocation integration", () => {
  const namespace = `test:session-revocation:${randomUUID()}:`;
  const redis = createRedisConnection({ url: redisUrl!, connectionName: namespace });
  const sessions = new RedisSessionStore({
    redis: createAuthRedisStore(redis),
    configuration: {
      secret: "integration-session-secret-value-32-bytes",
      idleTtlSeconds: 300,
      absoluteTtlSeconds: 1_800,
      keyPrefix: `${namespace}session:`
    }
  });

  beforeAll(async () => {
    await connectRedis(redis);
  });

  afterAll(async () => {
    const keys = await redis.keys(`${namespace}*`);
    if (keys.length > 0) await redis.del(...keys);
    await closeRedis(redis);
  });

  it("does not recreate a revoked Redis session from a stale resolved record", async () => {
    const created = await sessions.create(randomUUID(), "1".repeat(64));
    const stale = await sessions.resolve(created.sessionId);
    expect(stale).not.toBeNull();

    await sessions.revoke(created.sessionId);

    await expect(sessions.touch(created.sessionId, stale!)).resolves.toBeNull();
    await expect(sessions.resolve(created.sessionId)).resolves.toBeNull();
  });

  it("does not recreate an old Redis session after session rotation", async () => {
    const userId = randomUUID();
    const initial = await sessions.create(userId, "1".repeat(64));
    const stale = await sessions.resolve(initial.sessionId);
    expect(stale).not.toBeNull();

    const rotated = await sessions.create(userId, "1".repeat(64), initial.sessionId);

    await expect(sessions.touch(initial.sessionId, stale!)).resolves.toBeNull();
    await expect(sessions.resolve(initial.sessionId)).resolves.toBeNull();
    await expect(sessions.resolve(rotated.sessionId)).resolves.not.toBeNull();
  });
});
