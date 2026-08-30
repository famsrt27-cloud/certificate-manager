import { describe, expect, it } from "vitest";

import { loadDevelopmentAdminEnvironment } from "./development-admin-environment.js";

describe("development admin bootstrap environment", () => {
  it("accepts an explicit local development database", () => {
    expect(loadDevelopmentAdminEnvironment({
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://certificate_app:synthetic@127.0.0.1:5432/certificate_platform",
      BCRYPT_COST: "12"
    })).toEqual({
      bcryptCost: 12,
      databaseUrl: "postgresql://certificate_app:synthetic@127.0.0.1:5432/certificate_platform"
    });
  });

  it("rejects production execution before database access", () => {
    expect(() => loadDevelopmentAdminEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://certificate_app:synthetic@localhost:5432/certificate_platform"
    })).toThrow("NODE_ENV=development");
  });

  it("rejects non-local and implicit database targets", () => {
    expect(() => loadDevelopmentAdminEnvironment({ NODE_ENV: "development" })).toThrow("explicit DATABASE_URL");
    expect(() => loadDevelopmentAdminEnvironment({
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://certificate_app:synthetic@database.example.invalid:5432/certificate_platform"
    })).toThrow("requires a PostgreSQL database on localhost");
  });
});
