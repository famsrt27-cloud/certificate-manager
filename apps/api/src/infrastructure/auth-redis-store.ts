import type { AuthRedisStore } from "@certificate-platform/auth";
import type { Redis } from "ioredis";

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

export const createAuthRedisStore = (redis: Redis): AuthRedisStore => ({
  get: (key) => redis.get(key),
  setWithExpiry: async (key, value, ttlSeconds) => {
    await redis.set(key, value, "EX", ttlSeconds);
  },
  delete: async (key) => {
    await redis.del(key);
  },
  incrementWithExpiry: async (key, ttlSeconds) => {
    const result = await redis.eval(INCREMENT_WITH_EXPIRY_SCRIPT, 1, key, ttlSeconds);
    if (!Array.isArray(result) || result.length !== 2) throw new Error("Redis rate-limit response was invalid");
    const count = Number(result[0]);
    const remainingTtl = Number(result[1]);
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(remainingTtl)) {
      throw new Error("Redis rate-limit response was invalid");
    }
    return { count, ttlSeconds: remainingTtl };
  }
});
