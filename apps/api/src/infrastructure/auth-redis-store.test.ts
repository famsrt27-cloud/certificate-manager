import type { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";

import { createAuthRedisStore } from "./auth-redis-store.js";

describe("auth Redis store observability", () => {
  it("records a failure without recording a key or value", async () => {
    const observer = { onFailure: vi.fn() };
    const redis = {
      get: vi.fn().mockRejectedValue(new Error("redis unavailable"))
    } as unknown as Redis;
    const store = createAuthRedisStore(redis, observer);

    await expect(store.get("session:opaque-value")).rejects.toThrow("redis unavailable");

    expect(observer.onFailure).toHaveBeenCalledOnce();
    expect(observer.onFailure).toHaveBeenCalledWith();
  });
});
