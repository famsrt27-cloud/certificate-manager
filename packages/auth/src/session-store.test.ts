import { describe, expect, it } from "vitest";

import { RedisSessionStore, type SessionRedisStore } from "./session-store.js";

class MemoryRedis implements SessionRedisStore {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async setWithExpiry(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async setWithExpiryIfExists(key: string, value: string): Promise<boolean> {
    if (!this.values.has(key)) return false;
    this.values.set(key, value);
    return true;
  }
  async delete(key: string): Promise<void> { this.values.delete(key); }
  async incrementWithExpiry(): Promise<{ count: number; ttlSeconds: number }> {
    return { count: 1, ttlSeconds: 60 };
  }
}

const tokens = ["a".repeat(43), "b".repeat(43), "c".repeat(43), "d".repeat(43)];

describe("Redis session store", () => {
  it("rotates a supplied session ID and binds a new CSRF token", async () => {
    const redis = new MemoryRedis();
    let index = 0;
    const store = new RedisSessionStore({
      redis,
      configuration: { secret: "s".repeat(32), idleTtlSeconds: 30, absoluteTtlSeconds: 60 },
      now: () => 1_000,
      randomToken: () => tokens[index++] ?? "z".repeat(43)
    });
    const initial = await store.create("00000000-0000-4000-8000-000000000001", "1".repeat(64));
    const rotated = await store.create(
      "00000000-0000-4000-8000-000000000001",
      "1".repeat(64),
      initial.sessionId
    );

    await expect(store.resolve(initial.sessionId)).resolves.toBeNull();
    expect(rotated.sessionId).not.toBe(initial.sessionId);
    expect(rotated.record.csrfToken).not.toBe(initial.record.csrfToken);
    expect(store.validateCsrf(rotated.record, initial.record.csrfToken)).toBe(false);
    expect(store.validateCsrf(rotated.record, rotated.record.csrfToken)).toBe(true);
  });

  it("does not resurrect a revoked session when a stale request touches it", async () => {
    const redis = new MemoryRedis();
    let index = 0;
    const store = new RedisSessionStore({
      redis,
      configuration: { secret: "s".repeat(32), idleTtlSeconds: 30, absoluteTtlSeconds: 60 },
      now: () => 1_000,
      randomToken: () => tokens[index++] ?? "z".repeat(43)
    });
    const created = await store.create("00000000-0000-4000-8000-000000000001", "1".repeat(64));
    const stale = await store.resolve(created.sessionId);
    expect(stale).not.toBeNull();

    await store.revoke(created.sessionId);

    await expect(store.touch(created.sessionId, stale!)).resolves.toBeNull();
    await expect(store.resolve(created.sessionId)).resolves.toBeNull();
  });

  it("does not resurrect a rotated session when an in-flight request touches the old record", async () => {
    const redis = new MemoryRedis();
    let index = 0;
    const store = new RedisSessionStore({
      redis,
      configuration: { secret: "s".repeat(32), idleTtlSeconds: 30, absoluteTtlSeconds: 60 },
      now: () => 1_000,
      randomToken: () => tokens[index++] ?? "z".repeat(43)
    });
    const initial = await store.create("00000000-0000-4000-8000-000000000001", "1".repeat(64));
    const stale = await store.resolve(initial.sessionId);
    expect(stale).not.toBeNull();

    const rotated = await store.create(
      "00000000-0000-4000-8000-000000000001",
      "1".repeat(64),
      initial.sessionId
    );

    await expect(store.touch(initial.sessionId, stale!)).resolves.toBeNull();
    await expect(store.resolve(initial.sessionId)).resolves.toBeNull();
    await expect(store.resolve(rotated.sessionId)).resolves.not.toBeNull();
  });

  it("fails a session after absolute expiry even if Redis still contains it", async () => {
    const redis = new MemoryRedis();
    let now = 1_000;
    const store = new RedisSessionStore({
      redis,
      configuration: { secret: "s".repeat(32), idleTtlSeconds: 30, absoluteTtlSeconds: 60 },
      now: () => now,
      randomToken: () => tokens.shift() ?? "z".repeat(43)
    });
    const created = await store.create("00000000-0000-4000-8000-000000000001", "1".repeat(64));

    now = 61_001;

    await expect(store.resolve(created.sessionId)).resolves.toBeNull();
  });

  it("stores only a keyed digest of the browser session ID in Redis", async () => {
    const redis = new MemoryRedis();
    const store = new RedisSessionStore({
      redis,
      configuration: { secret: "s".repeat(32), idleTtlSeconds: 30, absoluteTtlSeconds: 60 },
      randomToken: () => "x".repeat(43)
    });
    const created = await store.create("00000000-0000-4000-8000-000000000001", "1".repeat(64));

    expect([...redis.values.keys()].join(" ")).not.toContain(created.sessionId);
  });
});
