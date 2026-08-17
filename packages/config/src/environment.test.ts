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
  SESSION_SECRET: "synthetic-session-secret-at-least-32-bytes"
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
  });

  it("applies worker and public web defaults", () => {
    expect(loadWorkerEnvironment(infrastructure).WORKER_HEALTH_PORT).toBe(3_002);
    expect(loadWebPublicEnvironment({}).NEXT_PUBLIC_API_BASE_PATH).toBe("/api");
  });

  it("reports field names without retaining secret values", () => {
    const secretValue = "must-not-appear-in-validation-output";

    try {
      loadApiEnvironment({
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

  it("rejects insecure production origins and invalid session expiry", () => {
    expect(() => loadApiEnvironment({
      ...infrastructure,
      NODE_ENV: "production",
      ADMIN_ALLOWED_ORIGINS: "http://admin.example.invalid"
    })).toThrow(EnvironmentValidationError);
    expect(() => loadApiEnvironment({
      ...infrastructure,
      SESSION_IDLE_TTL_SECONDS: "3600",
      SESSION_ABSOLUTE_TTL_SECONDS: "1800"
    })).toThrow(EnvironmentValidationError);
  });
});
