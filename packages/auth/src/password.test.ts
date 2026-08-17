import { describe, expect, it } from "vitest";

import {
  BCRYPT_MAX_PASSWORD_BYTES,
  InvalidPasswordInputError,
  hashPassword,
  passwordUtf8Length,
  verifyPassword
} from "./password.js";

describe("bcrypt password boundary", () => {
  it("hashes and verifies a password that is exactly 72 UTF-8 bytes", async () => {
    const password = "ก".repeat(24);

    expect(passwordUtf8Length(password)).toBe(BCRYPT_MAX_PASSWORD_BYTES);
    const hash = await hashPassword(password, 12);

    await expect(verifyPassword(password, hash)).resolves.toBe(true);
    await expect(verifyPassword(`${password}a`, hash)).resolves.toBe(false);
  });

  it("rejects hashing input beyond 72 UTF-8 bytes instead of silently truncating", async () => {
    const password = `${"ก".repeat(24)}a`;

    await expect(hashPassword(password, 12)).rejects.toBeInstanceOf(InvalidPasswordInputError);
  });

  it("enforces the approved minimum bcrypt cost", async () => {
    await expect(hashPassword("synthetic-password", 11)).rejects.toThrow("Bcrypt cost");
  });

  it("rejects new password hashes shorter than the provisioning policy", async () => {
    await expect(hashPassword("short", 12)).rejects.toBeInstanceOf(InvalidPasswordInputError);
  });
});
