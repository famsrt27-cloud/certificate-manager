import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { z } from "zod";

import type { AuthRedisStore } from "./session-store.js";

const scrypt = promisify(scryptCallback);
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TotpSecretSchema = z.string().regex(/^[A-Z2-7]{32}$/);
const MFA_CHALLENGE_TTL_SECONDS = 300;

export const MFA_TOTP_PERIOD_SECONDS = 30;
export const MFA_TOTP_DIGITS = 6;

export const generateTotpSecret = (): string => encodeBase32(randomBytes(20));

const encodeBase32 = (bytes: Uint8Array): string => {
  let bits = 0;
  let value = 0;
  let result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return result;
};

const decodeBase32 = (encoded: string): Buffer => {
  TotpSecretSchema.parse(encoded);
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of encoded) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
};

export const totpForTimestep = (secret: string, timestep: number): string => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(timestep));
  const digest = createHmac("sha1", decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = (digest.readUInt32BE(offset) & 0x7fff_ffff) % (10 ** MFA_TOTP_DIGITS);
  return binary.toString().padStart(MFA_TOTP_DIGITS, "0");
};

export const findTotpTimestep = (
  secret: string,
  code: string,
  nowMs = Date.now(),
  window = 1
): number | null => {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(nowMs / 1_000 / MFA_TOTP_PERIOD_SECONDS);
  for (let offset = -window; offset <= window; offset += 1) {
    const timestep = current + offset;
    const expected = Buffer.from(totpForTimestep(secret, timestep));
    const provided = Buffer.from(code);
    if (timingSafeEqual(expected, provided)) return timestep;
  }
  return null;
};

export const createTotpProvisioningUri = (secret: string, email: string): string => {
  const issuer = "Certificate Platform";
  const label = `${issuer}:${email}`;
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
};

export const generateRecoveryCodes = (): readonly string[] =>
  Array.from({ length: 10 }, () => randomBytes(18).toString("base64url"));

export const hashRecoveryCode = async (code: string): Promise<string> => {
  const salt = randomBytes(16);
  const derived = await scrypt(code, salt, 32) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
};

export const verifyRecoveryCode = async (code: string, encodedHash: string): Promise<boolean> => {
  const parts = encodedHash.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1]!, "base64url");
  const expected = Buffer.from(parts[2]!, "base64url");
  if (salt.length !== 16 || expected.length !== 32) return false;
  const actual = await scrypt(code, salt, expected.length) as Buffer;
  return timingSafeEqual(expected, actual);
};

export class MfaSecretCipher {
  readonly #key: Buffer;

  constructor(key: Uint8Array) {
    if (key.byteLength !== 32) throw new Error("MFA encryption key must contain exactly 32 bytes");
    this.#key = Buffer.from(key);
  }

  encrypt(plaintext: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `v1.${nonce.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
  }

  decrypt(value: string): string {
    const parts = value.split(".");
    if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Encrypted MFA value is invalid");
    const nonce = Buffer.from(parts[1]!, "base64url");
    const tag = Buffer.from(parts[2]!, "base64url");
    const ciphertext = Buffer.from(parts[3]!, "base64url");
    if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error("Encrypted MFA value is invalid");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
}

const PendingMfaChallengeSchema = z.object({
  version: z.literal(1),
  userId: z.uuid(),
  kind: z.enum(["ENROLLMENT", "CHALLENGE"]),
  secret: TotpSecretSchema.optional(),
  recoveryCodes: z.array(z.string().regex(/^[A-Za-z0-9_-]{24}$/)).length(10).optional(),
  attempts: z.number().int().min(0).max(5),
  expiresAt: z.number().int().positive()
}).superRefine((value, context) => {
  if (value.kind === "ENROLLMENT" && (value.secret === undefined || value.recoveryCodes === undefined)) {
    context.addIssue({ code: "custom", message: "enrollment challenge is incomplete" });
  }
});

export type PendingMfaChallenge = z.infer<typeof PendingMfaChallengeSchema>;

export interface MfaRedisStore extends AuthRedisStore {
  getAndDelete(key: string): Promise<string | null>;
}

export class RedisMfaChallengeStore {
  readonly #redis: MfaRedisStore;
  readonly #cipher: MfaSecretCipher;
  readonly #key: Buffer;
  readonly #now: () => number;

  constructor(redis: MfaRedisStore, key: Uint8Array, now = Date.now) {
    this.#redis = redis;
    this.#cipher = new MfaSecretCipher(key);
    this.#key = Buffer.from(key);
    this.#now = now;
  }

  async create(challenge: Omit<PendingMfaChallenge, "version" | "attempts" | "expiresAt">): Promise<string> {
    const id = randomBytes(32).toString("base64url");
    const record = PendingMfaChallengeSchema.parse({
      ...challenge,
      version: 1,
      attempts: 0,
      expiresAt: this.#now() + MFA_CHALLENGE_TTL_SECONDS * 1_000
    });
    await this.#redis.setWithExpiry(
      this.#redisKey(id),
      this.#cipher.encrypt(JSON.stringify(record)),
      MFA_CHALLENGE_TTL_SECONDS
    );
    return id;
  }

  async take(id: string): Promise<PendingMfaChallenge | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
    const value = await this.#redis.getAndDelete(this.#redisKey(id));
    if (value === null) return null;
    try {
      const challenge = PendingMfaChallengeSchema.parse(JSON.parse(this.#cipher.decrypt(value)));
      return challenge.expiresAt > this.#now() ? challenge : null;
    } catch {
      return null;
    }
  }

  async recordFailure(id: string, challenge: PendingMfaChallenge): Promise<void> {
    const attempts = challenge.attempts + 1;
    const remainingTtlSeconds = Math.ceil((challenge.expiresAt - this.#now()) / 1_000);
    if (attempts >= 5 || remainingTtlSeconds <= 0) {
      await this.delete(id);
      return;
    }
    await this.#redis.setWithExpiry(
      this.#redisKey(id),
      this.#cipher.encrypt(JSON.stringify({ ...challenge, attempts })),
      remainingTtlSeconds
    );
  }

  async delete(id: string): Promise<void> {
    if (/^[A-Za-z0-9_-]{43}$/.test(id)) await this.#redis.delete(this.#redisKey(id));
  }

  #redisKey(id: string): string {
    return `auth:mfa-challenge:v1:${createHmac("sha256", this.#key).update(id).digest("hex")}`;
  }
}
