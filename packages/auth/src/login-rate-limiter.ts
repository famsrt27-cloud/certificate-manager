import { createHmac } from "node:crypto";

import type { AuthRedisStore } from "./session-store.js";

export interface LoginRateLimitConfiguration {
  readonly secret: string;
  readonly windowSeconds: number;
  readonly accountMaximum: number;
  readonly networkMaximum: number;
  readonly keyPrefix?: string;
}

export interface LoginRateLimitResult {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
  readonly auditSuggested: boolean;
}

export class LoginRateLimiter {
  readonly #redis: AuthRedisStore;
  readonly #configuration: LoginRateLimitConfiguration;

  constructor(redis: AuthRedisStore, configuration: LoginRateLimitConfiguration) {
    this.#redis = redis;
    this.#configuration = configuration;
  }

  async consume(normalizedEmail: string, networkAddress: string): Promise<LoginRateLimitResult> {
    const [account, network] = await Promise.all([
      this.#redis.incrementWithExpiry(this.#key("account", normalizedEmail), this.#configuration.windowSeconds),
      this.#redis.incrementWithExpiry(this.#key("network", networkAddress), this.#configuration.windowSeconds)
    ]);
    const allowed = account.count <= this.#configuration.accountMaximum
      && network.count <= this.#configuration.networkMaximum;
    return {
      allowed,
      retryAfterSeconds: allowed ? 0 : Math.max(account.ttlSeconds, network.ttlSeconds, 1),
      auditSuggested: !allowed && (network.count === this.#configuration.networkMaximum + 1
        || (network.count <= this.#configuration.networkMaximum
          && account.count === this.#configuration.accountMaximum + 1))
    };
  }

  async resetAccount(normalizedEmail: string): Promise<void> {
    await this.#redis.delete(this.#key("account", normalizedEmail));
  }

  #key(scope: "account" | "network", value: string): string {
    const digest = createHmac("sha256", this.#configuration.secret).update(`${scope}:${value}`).digest("hex");
    return `${this.#configuration.keyPrefix ?? "auth:login-rate:v1:"}${scope}:${digest}`;
  }
}
