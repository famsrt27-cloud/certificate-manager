import { describe, expect, it } from "vitest";

import { PublicVerificationRateLimiter } from "./public-verification-rate-limiter.js";
import type { AuthRedisStore } from "./session-store.js";

const createStore = () => {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  const store: AuthRedisStore = {
    get: async () => null,
    setWithExpiry: async () => undefined,
    delete: async () => undefined,
    incrementWithExpiry: async (key, ttlSeconds) => {
      keys.push(key);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { count, ttlSeconds };
    }
  };
  return { store, keys };
};

describe("PublicVerificationRateLimiter", () => {
  it("shares distributed counts and hashes normalized network addresses", async () => {
    const { store, keys } = createStore();
    const configuration = { secret: "public-rate-limit-secret-at-least-32-bytes", windowSeconds: 60, networkMaximum: 2 };
    const firstInstance = new PublicVerificationRateLimiter(store, configuration);
    const secondInstance = new PublicVerificationRateLimiter(store, configuration);
    expect((await firstInstance.consume(" 192.0.2.10 ")).allowed).toBe(true);
    expect((await secondInstance.consume("192.0.2.10")).allowed).toBe(true);
    expect(await firstInstance.consume("192.0.2.10")).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(keys.every((key) => !key.includes("192.0.2.10") && /^[a-f0-9]{64}$/.test(key.split(":").at(-1)!))).toBe(true);
  });

  it("rejects weak or invalid configuration", () => {
    const { store } = createStore();
    expect(() => new PublicVerificationRateLimiter(store, { secret: "weak", windowSeconds: 60, networkMaximum: 1 })).toThrow();
  });
});
