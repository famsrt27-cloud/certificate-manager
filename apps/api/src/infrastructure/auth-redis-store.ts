import type { MfaRedisStore, SessionRedisStore } from "@certificate-platform/auth";
import type { Redis } from "ioredis";

export interface AuthRedisFailureObserver {
  onFailure(): void;
}

const INCREMENT_WITH_EXPIRY_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

const observeFailure = async <Value>(operation: Promise<Value>, observer: AuthRedisFailureObserver | undefined): Promise<Value> => {
  try {
    return await operation;
  } catch (error) {
    observer?.onFailure();
    throw error;
  }
};

export const createAuthRedisStore = (
  redis: Redis,
  observer?: AuthRedisFailureObserver
): SessionRedisStore & MfaRedisStore => ({
  get: (key) => observeFailure(redis.get(key), observer),
  getAndDelete: (key) => observeFailure(redis.getdel(key), observer),
  setWithExpiry: async (key, value, ttlSeconds) => {
    await observeFailure(redis.set(key, value, "EX", ttlSeconds), observer);
  },
  setWithExpiryIfExists: async (key, value, ttlSeconds) => {
    const result = await observeFailure(redis.set(key, value, "EX", ttlSeconds, "XX"), observer);
    return result === "OK";
  },
  delete: async (key) => {
    await observeFailure(redis.del(key), observer);
  },
  incrementWithExpiry: async (key, ttlSeconds) => {
    const result = await observeFailure(redis.eval(INCREMENT_WITH_EXPIRY_SCRIPT, 1, key, ttlSeconds), observer);
    if (!Array.isArray(result) || result.length !== 2) {
      observer?.onFailure();
      throw new Error("Redis rate-limit response was invalid");
    }
    const count = Number(result[0]);
    const remainingTtl = Number(result[1]);
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(remainingTtl)) {
      observer?.onFailure();
      throw new Error("Redis rate-limit response was invalid");
    }
    return { count, ttlSeconds: remainingTtl };
  }
});
