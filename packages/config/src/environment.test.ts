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

describe("environment validation", () => {
  it("applies safe API defaults", () => {
    const environment = loadApiEnvironment(infrastructure);

    expect(environment.API_HOST).toBe("0.0.0.0");
    expect(environment.API_PORT).toBe(3_001);
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
        ...infrastructure,
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

  it("keeps production HTTPS origins and MFA fail-closed", () => {
    try {
      loadApiEnvironment({
        ...infrastructure,
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
          message: "production admin authentication requires an approved MFA contract and implementation"
        })
      ]));
    }

    expect(() => loadApiEnvironment({
      ...infrastructure,
      NODE_ENV: "production",
      ADMIN_ALLOWED_ORIGINS: "https://admin.example.invalid"
    })).toThrowError(expect.objectContaining({
      issues: [expect.objectContaining({ path: "ADMIN_MFA_POLICY" })]
    }));
  });

  it("rejects invalid session expiry", () => {
    expect(() => loadApiEnvironment({
      ...infrastructure,
      SESSION_IDLE_TTL_SECONDS: "3600",
      SESSION_ABSOLUTE_TTL_SECONDS: "1800"
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
