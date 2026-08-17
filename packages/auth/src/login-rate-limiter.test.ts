import { describe, expect, it } from "vitest";

import { LoginRateLimiter } from "./login-rate-limiter.js";
import type { AuthRedisStore } from "./session-store.js";

class CounterRedis implements AuthRedisStore {
  readonly counters = new Map<string, number>();
  async get(): Promise<string | null> { return null; }
  async setWithExpiry(): Promise<void> { return undefined; }
  async delete(key: string): Promise<void> { this.counters.delete(key); }
  async incrementWithExpiry(key: string): Promise<{ count: number; ttlSeconds: number }> {
    const count = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, count);
    return { count, ttlSeconds: 900 };
  }
}

describe("distributed login rate limiter", () => {
  it("limits both account and network dimensions without putting PII in Redis keys", async () => {
    const redis = new CounterRedis();
    const limiter = new LoginRateLimiter(redis, {
      secret: "s".repeat(32),
      windowSeconds: 900,
      accountMaximum: 2,
      networkMaximum: 10
    });

    await expect(limiter.consume("admin@example.invalid", "192.0.2.1")).resolves.toMatchObject({ allowed: true });
    await expect(limiter.consume("admin@example.invalid", "192.0.2.1")).resolves.toMatchObject({ allowed: true });
    await expect(limiter.consume("admin@example.invalid", "192.0.2.1")).resolves.toMatchObject({ allowed: false });
    expect([...redis.counters.keys()].join(" ")).not.toContain("admin@example.invalid");
    expect([...redis.counters.keys()].join(" ")).not.toContain("192.0.2.1");
  });
});
