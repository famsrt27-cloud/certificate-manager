import { Redis } from "ioredis";

export interface RedisConnectionConfig {
  readonly url: string;
  readonly connectionName: string;
}

export const createRedisConnection = ({
  url,
  connectionName
}: RedisConnectionConfig): Redis =>
  new Redis(url, {
    connectionName,
    lazyConnect: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 100, 2_000)
  });

export const connectRedis = async (redis: Redis): Promise<void> => {
  if (redis.status === "wait") {
    await redis.connect();
  }
};

export const checkRedis = async (redis: Redis): Promise<void> => {
  const response = await redis.ping();
  if (response !== "PONG") {
    throw new Error("Redis health check failed");
  }
};

export const closeRedis = async (redis: Redis): Promise<void> => {
  if (redis.status === "end") {
    return;
  }

  try {
    await redis.quit();
  } catch {
    redis.disconnect(false);
  }
};
