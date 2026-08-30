import { randomUUID } from "node:crypto";

import { PublicVerificationRateLimiter } from "@certificate-platform/auth";
import { closeRedis, connectRedis, createRedisConnection } from "@certificate-platform/queue";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAuthRedisStore } from "../../src/infrastructure/auth-redis-store.js";

const redisUrl = process.env.TEST_REDIS_URL;

describe.skipIf(redisUrl === undefined)("public Redis rate-limit abuse integration", () => {
  const namespace = `test:public-rate-abuse:${randomUUID()}:`;
  const redis = createRedisConnection({ url: redisUrl!, connectionName: `public-rate-abuse-${randomUUID()}` });
  const store = createAuthRedisStore(redis);
  const configuration = {
    secret: "synthetic-public-rate-limit-secret-at-least-32-bytes",
    windowSeconds: 60,
    networkMaximum: 10,
    keyPrefix: `${namespace}verification:`
  } as const;

  beforeAll(async () => {
    await connectRedis(redis);
  });

  afterAll(async () => {
    const keys = await redis.keys(`${namespace}*`);
    if (keys.length > 0) await redis.del(...keys);
    await closeRedis(redis);
  });

  it("atomically enforces a shared limit across concurrent API limiter instances", async () => {
    const first = new PublicVerificationRateLimiter(store, configuration);
    const second = new PublicVerificationRateLimiter(store, configuration);
    const attempts = await Promise.all(Array.from({ length: 40 }, (_, index) =>
      (index % 2 === 0 ? first : second).consume("192.0.2.42")));

    expect(attempts.filter((result) => result.allowed)).toHaveLength(10);
    const rejected = attempts.filter((result) => !result.allowed);
    expect(rejected).toHaveLength(30);
    expect(rejected.every((result) => result.retryAfterSeconds > 0)).toBe(true);
  });

  it("keeps designed route buckets distinct and resets from isolated Redis state deterministically", async () => {
    const verification = new PublicVerificationRateLimiter(store, {
      ...configuration,
      networkMaximum: 1,
      keyPrefix: `${namespace}verification-distinct:`
    });
    const download = new PublicVerificationRateLimiter(store, {
      ...configuration,
      networkMaximum: 1,
      keyPrefix: `${namespace}download-distinct:`
    });

    expect((await verification.consume("192.0.2.43")).allowed).toBe(true);
    expect((await verification.consume("192.0.2.43")).allowed).toBe(false);
    expect((await download.consume("192.0.2.43")).allowed).toBe(true);

    const verificationKeys = await redis.keys(`${namespace}verification-distinct:*`);
    expect(verificationKeys).toHaveLength(1);
    await redis.del(...verificationKeys);
    expect((await verification.consume("192.0.2.43")).allowed).toBe(true);
  });

  it("allows 30 requests in each suggestion bucket while certificate search remains limited to 5", async () => {
    const projectSuggestions = new PublicVerificationRateLimiter(store, {
      ...configuration, networkMaximum: 30, keyPrefix: `${namespace}project-suggestion-policy:`
    });
    const trainingSuggestions = new PublicVerificationRateLimiter(store, {
      ...configuration, networkMaximum: 30, keyPrefix: `${namespace}training-suggestion-policy:`
    });
    const certificateSearch = new PublicVerificationRateLimiter(store, {
      ...configuration, networkMaximum: 5, keyPrefix: `${namespace}certificate-search-policy:`
    });
    const consume = async (limiter: PublicVerificationRateLimiter, count: number) =>
      Promise.all(Array.from({ length: count }, () => limiter.consume("192.0.2.44")));

    const [projects, trainings, searches] = await Promise.all([
      consume(projectSuggestions, 31), consume(trainingSuggestions, 31), consume(certificateSearch, 6)
    ]);
    expect(projects.filter((result) => result.allowed)).toHaveLength(30);
    expect(trainings.filter((result) => result.allowed)).toHaveLength(30);
    expect(searches.filter((result) => result.allowed)).toHaveLength(5);
    expect(projects[30]?.allowed).toBe(false);
    expect(trainings[30]?.allowed).toBe(false);
    expect(searches[5]?.allowed).toBe(false);
  });
});
