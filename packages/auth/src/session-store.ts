import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

export interface AuthRedisStore {
  get(key: string): Promise<string | null>;
  setWithExpiry(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  incrementWithExpiry(key: string, ttlSeconds: number): Promise<{ count: number; ttlSeconds: number }>;
}

export interface SessionConfiguration {
  readonly secret: string;
  readonly idleTtlSeconds: number;
  readonly absoluteTtlSeconds: number;
  readonly keyPrefix?: string;
}

const SessionRecordSchema = z.object({
  version: z.literal(1),
  userId: z.uuid(),
  csrfToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  authorizationVersion: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative(),
  absoluteExpiresAt: z.number().int().positive()
});

export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export interface CreatedSession {
  readonly sessionId: string;
  readonly record: SessionRecord;
}

export interface SessionStoreOptions {
  readonly redis: AuthRedisStore;
  readonly configuration: SessionConfiguration;
  readonly now?: () => number;
  readonly randomToken?: () => string;
}

const defaultRandomToken = (): string => randomBytes(32).toString("base64url");

export class RedisSessionStore {
  readonly #redis: AuthRedisStore;
  readonly #configuration: SessionConfiguration;
  readonly #now: () => number;
  readonly #randomToken: () => string;

  constructor({ redis, configuration, now = Date.now, randomToken = defaultRandomToken }: SessionStoreOptions) {
    if (Buffer.byteLength(configuration.secret, "utf8") < 32) {
      throw new Error("Session secret must contain at least 32 UTF-8 bytes");
    }
    if (configuration.idleTtlSeconds <= 0 || configuration.absoluteTtlSeconds < configuration.idleTtlSeconds) {
      throw new Error("Session expiry configuration is invalid");
    }
    this.#redis = redis;
    this.#configuration = configuration;
    this.#now = now;
    this.#randomToken = randomToken;
  }

  async create(userId: string, authorizationVersion: string, previousSessionId?: string): Promise<CreatedSession> {
    if (previousSessionId !== undefined) await this.revoke(previousSessionId);

    const now = this.#now();
    const sessionId = this.#randomToken();
    const record: SessionRecord = {
      version: 1,
      userId,
      csrfToken: this.#randomToken(),
      authorizationVersion,
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: now + this.#configuration.absoluteTtlSeconds * 1_000
    };
    await this.#write(sessionId, record);
    return { sessionId, record };
  }

  async resolve(sessionId: string): Promise<SessionRecord | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(sessionId)) return null;
    const value = await this.#redis.get(this.#key(sessionId));
    if (value === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      await this.revoke(sessionId);
      return null;
    }
    const result = SessionRecordSchema.safeParse(parsed);
    if (!result.success || result.data.absoluteExpiresAt <= this.#now()) {
      await this.revoke(sessionId);
      return null;
    }
    return result.data;
  }

  async touch(sessionId: string, record: SessionRecord): Promise<SessionRecord | null> {
    const now = this.#now();
    if (record.absoluteExpiresAt <= now) {
      await this.revoke(sessionId);
      return null;
    }
    const touched = { ...record, lastSeenAt: now };
    await this.#write(sessionId, touched);
    return touched;
  }

  async revoke(sessionId: string): Promise<void> {
    if (/^[A-Za-z0-9_-]{43}$/.test(sessionId)) await this.#redis.delete(this.#key(sessionId));
  }

  validateCsrf(record: SessionRecord, providedToken: string | undefined): boolean {
    if (providedToken === undefined) return false;
    const expected = Buffer.from(record.csrfToken, "utf8");
    const provided = Buffer.from(providedToken, "utf8");
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  }

  #key(sessionId: string): string {
    const digest = createHmac("sha256", this.#configuration.secret).update(sessionId).digest("hex");
    return `${this.#configuration.keyPrefix ?? "auth:session:v1:"}${digest}`;
  }

  async #write(sessionId: string, record: SessionRecord): Promise<void> {
    const remainingAbsoluteSeconds = Math.ceil((record.absoluteExpiresAt - this.#now()) / 1_000);
    const ttl = Math.min(this.#configuration.idleTtlSeconds, remainingAbsoluteSeconds);
    if (ttl <= 0) {
      await this.revoke(sessionId);
      return;
    }
    await this.#redis.setWithExpiry(this.#key(sessionId), JSON.stringify(record), ttl);
  }
}
