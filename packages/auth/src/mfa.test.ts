import { describe, expect, it } from "vitest";

import { MfaSecretCipher, RedisMfaChallengeStore, findTotpTimestep, totpForTimestep,
  type MfaRedisStore } from "./mfa.js";

class MemoryMfaRedis implements MfaRedisStore {
  readonly values = new Map<string, string>();
  lastTtlSeconds: number | null = null;
  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async getAndDelete(key: string): Promise<string | null> {
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  }
  async setWithExpiry(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.values.set(key, value);
    this.lastTtlSeconds = ttlSeconds;
  }
  async delete(key: string): Promise<void> { this.values.delete(key); }
  async incrementWithExpiry(): Promise<{ count: number; ttlSeconds: number }> {
    throw new Error("not used by MFA challenge tests");
  }
}

describe("TOTP MFA primitives", () => {
  it("implements the RFC 6238 SHA-1 vector with six-digit truncation", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(totpForTimestep(secret, 1)).toBe("287082");
    expect(findTotpTimestep(secret, "287082", 59_000, 0)).toBe(1);
  });

  it("authenticates encrypted secret storage and rejects another key", () => {
    const cipher = new MfaSecretCipher(Buffer.alloc(32, 1));
    const encrypted = cipher.encrypt("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(encrypted).not.toContain("GEZDGNBV");
    expect(cipher.decrypt(encrypted)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(() => new MfaSecretCipher(Buffer.alloc(32, 2)).decrypt(encrypted)).toThrow();
  });

  it("preserves the original challenge expiry after a failed attempt", async () => {
    const redis = new MemoryMfaRedis();
    let now = 1_800_000_000_000;
    const challenges = new RedisMfaChallengeStore(redis, Buffer.alloc(32, 1), () => now);
    const id = await challenges.create({
      userId: "00000000-0000-4000-8000-000000000001",
      kind: "CHALLENGE"
    });
    now += 180_000;
    const challenge = await challenges.take(id);
    expect(challenge).not.toBeNull();
    await challenges.recordFailure(id, challenge!);
    expect(redis.lastTtlSeconds).toBe(120);
    now += 121_000;
    expect(await challenges.take(id)).toBeNull();
  });
});
