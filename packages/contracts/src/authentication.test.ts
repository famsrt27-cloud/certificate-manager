import { describe, expect, it } from "vitest";

import { AuthenticatedMembershipSchema, LoginRequestSchema } from "./authentication.js";

describe("authentication wire contracts", () => {
  it("normalizes email and accepts exactly 72 UTF-8 password bytes", () => {
    const result = LoginRequestSchema.parse({
      email: "Admin@Example.Invalid",
      password: "ก".repeat(24)
    });

    expect(result.email).toBe("admin@example.invalid");
  });

  it("rejects bcrypt-truncating and unknown inputs", () => {
    expect(LoginRequestSchema.safeParse({
      email: "admin@example.invalid",
      password: `${"ก".repeat(24)}a`
    }).success).toBe(false);
    expect(LoginRequestSchema.safeParse({
      email: "admin@example.invalid",
      password: "synthetic-password",
      organization_id: "forged"
    }).success).toBe(false);
  });

  it("accepts canonical multi-segment permissions", () => {
    expect(AuthenticatedMembershipSchema.safeParse({
      id: "00000000-0000-4000-8000-000000000001",
      organization: { id: "00000000-0000-4000-8000-000000000002", name: "Synthetic" },
      roles: ["TEMPLATE_MANAGER"],
      permissions: ["template:asset:create"]
    }).success).toBe(true);
  });
});
