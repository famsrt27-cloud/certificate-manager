import { createHmac } from "node:crypto";

import type { AuthRedisStore } from "./session-store.js";

export interface PublicVerificationRateLimitConfiguration {
  readonly secret: string;
  readonly windowSeconds: number;
  readonly networkMaximum: number;
  readonly keyPrefix?: string;
}

export interface PublicVerificationRateLimitResult {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export class PublicVerificationRateLimiter {
  readonly #redis: AuthRedisStore;
  readonly #configuration: PublicVerificationRateLimitConfiguration;

  constructor(redis: AuthRedisStore, configuration: PublicVerificationRateLimitConfiguration) {
    if (Buffer.byteLength(configuration.secret, "utf8") < 32 || configuration.windowSeconds < 1
      || configuration.networkMaximum < 1) throw new Error("Public verification rate-limit configuration is invalid");
    this.#redis = redis;
    this.#configuration = configuration;
  }

  async consume(networkAddress: string): Promise<PublicVerificationRateLimitResult> {
    const normalizedAddress = networkAddress.trim().toLowerCase().slice(0, 128);
    const result = await this.#redis.incrementWithExpiry(this.#key(normalizedAddress), this.#configuration.windowSeconds);
    const allowed = result.count <= this.#configuration.networkMaximum;
    return { allowed, retryAfterSeconds: allowed ? 0 : Math.max(result.ttlSeconds, 1) };
  }

  #key(networkAddress: string): string {
    const digest = createHmac("sha256", this.#configuration.secret).update(`network:${networkAddress}`).digest("hex");
    return `${this.#configuration.keyPrefix ?? "public:verification-rate:v1:"}${digest}`;
  }
}
