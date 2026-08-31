import { describe, expect, it } from "vitest";
import {
  EnvironmentValidationError,
  loadApiEnvironment,
  loadWorkerEnvironment,
  loadWebPublicEnvironment
} from "./environment.js";

const infrastructure = {
  DATABASE_URL: "postgresql://app:synthetic-password@127.0.0.1:5432/certificate_test",
  REDIS_URL: "redis://:synthetic-password@127.0.0.1:6379/0",
  SESSION_SECRET: "synthetic-session-secret-at-least-32-bytes",
  OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:9000",
  OBJECT_STORAGE_BUCKET: "certificate-test-private",
  OBJECT_STORAGE_ACCESS_KEY: "synthetic-access-key",
  OBJECT_STORAGE_SECRET_KEY: "synthetic-storage-secret",
  VERIFICATION_PUBLIC_BASE_URL: "https://verify.example.invalid",
  VERIFICATION_ACTIVE_KID: "test-key",
  VERIFICATION_SIGNING_KEYS_JSON: JSON.stringify({ "test-key": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })
};

const productionInfrastructure = {
  ...infrastructure,
  DATABASE_URL: "postgresql://app:synthetic-password@postgres.example.invalid:5432/certificate_production?sslmode=verify-full",
  REDIS_URL: "rediss://:synthetic-password@redis.example.invalid:6379/0",
  OBJECT_STORAGE_ENDPOINT: "https://storage.example.invalid",
  OBJECT_STORAGE_CREATE_BUCKET: "false",
  BULLMQ_PREFIX: "certificate-platform-production",
  API_TRUST_PROXY_HOPS: "1",
  VERIFICATION_SIGNING_KEYS_JSON: JSON.stringify({ "test-key": Buffer.alloc(32, 9).toString("base64url") })
};

describe("environment validation", () => {
  it("applies safe API defaults", () => {
    const environment = loadApiEnvironment(infrastructure);

    expect(environment.API_HOST).toBe("0.0.0.0");
    expect(environment.API_PORT).toBe(3_001);
    expect(environment.API_TRUST_PROXY_HOPS).toBe(0);
    expect(environment.DATABASE_MAX_CONNECTIONS).toBe(10);
    expect(environment.READINESS_TIMEOUT_MS).toBe(2_000);
    expect(environment.SESSION_IDLE_TTL_SECONDS).toBe(1_800);
    expect(environment.SESSION_ABSOLUTE_TTL_SECONDS).toBe(28_800);
    expect(environment.BCRYPT_COST).toBe(12);
    expect(environment.ADMIN_MFA_POLICY).toBe("DEFERRED_NON_PRODUCTION");
    expect(environment.PARTICIPANT_IMPORT_MAX_BYTES).toBe(5 * 1_024 * 1_024);
    expect(environment.OBJECT_STORAGE_CREATE_BUCKET).toBe(false);
    expect(environment.PUBLIC_VERIFICATION_RATE_LIMIT_WINDOW_SECONDS).toBe(60);
    expect(environment.PUBLIC_VERIFICATION_RATE_LIMIT_NETWORK_MAX).toBe(30);
    expect(environment.PUBLIC_DOWNLOAD_TOKEN_TTL_SECONDS).toBe(60);
    expect(environment.PUBLIC_DOWNLOAD_AUTHORIZE_RATE_LIMIT_WINDOW_SECONDS).toBe(60);
    expect(environment.PUBLIC_DOWNLOAD_AUTHORIZE_RATE_LIMIT_NETWORK_MAX).toBe(10);
    expect(environment.PUBLIC_DOWNLOAD_RATE_LIMIT_WINDOW_SECONDS).toBe(60);
    expect(environment.PUBLIC_DOWNLOAD_RATE_LIMIT_NETWORK_MAX).toBe(10);
    expect(environment.PUBLIC_CERTIFICATE_SEARCH_RATE_LIMIT_WINDOW_SECONDS).toBe(60);
    expect(environment.PUBLIC_CERTIFICATE_SEARCH_RATE_LIMIT_NETWORK_MAX).toBe(5);
    expect(environment.PUBLIC_CERTIFICATE_SUGGESTION_RATE_LIMIT_WINDOW_SECONDS).toBe(60);
    expect(environment.PUBLIC_CERTIFICATE_SUGGESTION_RATE_LIMIT_NETWORK_MAX).toBe(30);
    expect(environment.PUBLIC_SEARCH_RESULT_TOKEN_TTL_SECONDS).toBe(180);
    expect(environment.PUBLIC_SEARCH_DOWNLOAD_AUTHORIZE_RATE_LIMIT_WINDOW_SECONDS).toBe(60);
    expect(environment.PUBLIC_SEARCH_DOWNLOAD_AUTHORIZE_RATE_LIMIT_NETWORK_MAX).toBe(10);
    expect(environment.CERTIFICATE_PDF_MAX_BYTES).toBe(10 * 1_024 * 1_024);
    expect(environment.VERIFICATION_SIGNING_KEYS_JSON["test-key"]).toHaveLength(32);
  });

  it("applies worker and public web defaults", () => {
    const worker = loadWorkerEnvironment(infrastructure);
    expect(worker.WORKER_HEALTH_PORT).toBe(3_002);
    expect(worker.CERTIFICATE_GENERATION_CONCURRENCY).toBe(2);
    expect(worker.VERIFICATION_SIGNING_KEYS_JSON["test-key"]).toHaveLength(32);
    expect(loadWebPublicEnvironment({}).NEXT_PUBLIC_API_BASE_PATH).toBe("/api");
  });

  it("reports field names without retaining secret values", () => {
    const secretValue = "must-not-appear-in-validation-output";

    try {
      loadApiEnvironment({
        ...productionInfrastructure,
        DATABASE_URL: secretValue,
        REDIS_URL: secretValue,
        SESSION_SECRET: "short"
      });
      throw new Error("expected environment validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentValidationError);
      expect(JSON.stringify(error)).not.toContain(secretValue);
      expect((error as EnvironmentValidationError).issues.map((issue) => issue.path)).toEqual([
        "DATABASE_URL",
        "REDIS_URL",
        "SESSION_SECRET"
      ]);
    }
  });

  it("rejects deferred MFA in production", () => {
    try {
      loadApiEnvironment({
        ...productionInfrastructure,
        NODE_ENV: "production",
        ADMIN_ALLOWED_ORIGINS: "http://admin.example.invalid"
      });
      throw new Error("expected production environment validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentValidationError);
      expect((error as EnvironmentValidationError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "ADMIN_ALLOWED_ORIGINS", message: "must use HTTPS in production" }),
        expect.objectContaining({
          path: "ADMIN_MFA_POLICY",
          message: "must be REQUIRED in production"
        })
      ]));
    }

    expect(() => loadApiEnvironment({
      ...productionInfrastructure,
      NODE_ENV: "production",
      ADMIN_ALLOWED_ORIGINS: "https://admin.example.invalid"
    })).toThrowError(expect.objectContaining({
      issues: [expect.objectContaining({ path: "ADMIN_MFA_POLICY" })]
    }));
  });

  it("accepts production only with required MFA and a dedicated 32-byte encryption key", () => {
    const environment = loadApiEnvironment({
      ...productionInfrastructure,
      NODE_ENV: "production",
      ADMIN_ALLOWED_ORIGINS: "https://admin.example.invalid",
      ADMIN_MFA_POLICY: "REQUIRED",
      ADMIN_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url")
    });
    expect(environment.ADMIN_MFA_POLICY).toBe("REQUIRED");
    expect(environment.ADMIN_MFA_ENCRYPTION_KEY).toHaveLength(32);
  });

  it("rejects the documented MFA encryption placeholder in production", () => {
    expect(() => loadApiEnvironment({
      ...productionInfrastructure,
      NODE_ENV: "production",
      ADMIN_ALLOWED_ORIGINS: "https://admin.example.invalid",
      ADMIN_MFA_POLICY: "REQUIRED",
      ADMIN_MFA_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64url")
    })).toThrow(expect.objectContaining({
      issues: [expect.objectContaining({
        path: "ADMIN_MFA_ENCRYPTION_KEY",
        message: "must not use the documented development placeholder in production"
      })]
    }));
  });

  it("rejects invalid session expiry", () => {
    expect(() => loadApiEnvironment({
      ...productionInfrastructure,
      SESSION_IDLE_TTL_SECONDS: "3600",
      SESSION_ABSOLUTE_TTL_SECONDS: "1800"
    })).toThrow(EnvironmentValidationError);
  });

  it("fails closed on production transport, bucket, namespace, and trusted-proxy gaps", () => {
    const invalid = (overrides: Record<string, string>) => expect(() => loadApiEnvironment({
      ...productionInfrastructure,
      NODE_ENV: "production",
      ADMIN_ALLOWED_ORIGINS: "https://admin.example.invalid",
      ADMIN_MFA_POLICY: "REQUIRED",
      ADMIN_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
      ...overrides
    })).toThrow(EnvironmentValidationError);

    invalid({ API_TRUST_PROXY_HOPS: "0" });
    invalid({ DATABASE_URL: "postgresql://app:synthetic-password@postgres.example.invalid/certificate_production" });
    invalid({ REDIS_URL: "redis://:synthetic-password@redis.example.invalid:6379/0" });
    invalid({ OBJECT_STORAGE_ENDPOINT: "http://storage.example.invalid" });
    invalid({ OBJECT_STORAGE_CREATE_BUCKET: "true" });
    invalid({ BULLMQ_PREFIX: "certificate-platform" });
  });

  it("applies the same private dependency requirements to production workers", () => {
    expect(() => loadWorkerEnvironment({ ...productionInfrastructure, NODE_ENV: "production" })).not.toThrow();
    expect(() => loadWorkerEnvironment({
      ...productionInfrastructure,
      NODE_ENV: "production",
      REDIS_URL: "redis://:synthetic-password@redis.example.invalid:6379/0"
    })).toThrow(EnvironmentValidationError);
  });

  it("rejects unknown active keys, duplicate kids, and weak verification keys", () => {
    expect(() => loadApiEnvironment({ ...infrastructure, VERIFICATION_ACTIVE_KID: "removed-key" }))
      .toThrow(EnvironmentValidationError);
    expect(() => loadApiEnvironment({ ...infrastructure, VERIFICATION_ACTIVE_KID: "toString" }))
      .toThrow(EnvironmentValidationError);
    expect(() => loadApiEnvironment({
      ...infrastructure,
      VERIFICATION_SIGNING_KEYS_JSON: '{"test-key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","test-key":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}'
    })).toThrow(EnvironmentValidationError);
    expect(() => loadApiEnvironment({
      ...infrastructure,
      VERIFICATION_SIGNING_KEYS_JSON: JSON.stringify({ "test-key": "d2Vhaw" })
    })).toThrow(EnvironmentValidationError);
  });

  it("rejects out-of-range public download settings", () => {
    expect(() => loadApiEnvironment({ ...infrastructure, PUBLIC_DOWNLOAD_TOKEN_TTL_SECONDS: "61" }))
      .toThrow(EnvironmentValidationError);
    expect(() => loadApiEnvironment({ ...infrastructure, PUBLIC_DOWNLOAD_TOKEN_TTL_SECONDS: "0" }))
      .toThrow(EnvironmentValidationError);
    expect(() => loadApiEnvironment({ ...infrastructure,
      PUBLIC_DOWNLOAD_AUTHORIZE_RATE_LIMIT_WINDOW_SECONDS: "9" })).toThrow(EnvironmentValidationError);
    expect(() => loadApiEnvironment({ ...infrastructure,
      PUBLIC_DOWNLOAD_AUTHORIZE_RATE_LIMIT_NETWORK_MAX: "0" })).toThrow(EnvironmentValidationError);
    expect(() => loadApiEnvironment({ ...infrastructure,
      PUBLIC_DOWNLOAD_RATE_LIMIT_WINDOW_SECONDS: "9" })).toThrow(EnvironmentValidationError);
    expect(() => loadApiEnvironment({ ...infrastructure,
      PUBLIC_DOWNLOAD_RATE_LIMIT_NETWORK_MAX: "0" })).toThrow(EnvironmentValidationError);
    expect(() => loadApiEnvironment({ ...infrastructure, CERTIFICATE_PDF_MAX_BYTES: "1023" }))
      .toThrow(EnvironmentValidationError);
  });
});
