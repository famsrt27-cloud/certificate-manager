import { describe, expect, it } from "vitest";

import {
  BCRYPT_MAX_PASSWORD_BYTES,
  InvalidPasswordInputError,
  hashPassword,
  passwordUtf8Length,
  verifyPassword
} from "./password.js";

describe("bcrypt password boundary", () => {
  it("accepts the exact 12-character provisioning boundary", async () => {
    const password = "abcdefghijkl";

    const hash = await hashPassword(password, 12);

    await expect(verifyPassword(password, hash)).resolves.toBe(true);
  });

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

  it("measures Unicode in UTF-8 bytes rather than code points", async () => {
    const withinBoundary = `${"ก".repeat(20)}abcdefghijkl`;
    const beyondBoundary = `${"ก".repeat(21)}abcdefghij`;

    expect([...withinBoundary]).toHaveLength(32);
    expect(passwordUtf8Length(withinBoundary)).toBe(72);
    expect([...beyondBoundary]).toHaveLength(31);
    expect(passwordUtf8Length(beyondBoundary)).toBe(73);
    await expect(hashPassword(withinBoundary, 12)).resolves.toMatch(/^\$2[aby]\$/);
    await expect(hashPassword(beyondBoundary, 12)).rejects.toBeInstanceOf(InvalidPasswordInputError);
  });

  it("rejects values that bcrypt would otherwise truncate into the same password", async () => {
    const prefix = "a".repeat(72);
    const hash = await hashPassword(prefix, 12);

    await expect(verifyPassword(`${prefix}x`, hash)).resolves.toBe(false);
    await expect(verifyPassword(`${prefix}y`, hash)).resolves.toBe(false);
  });

  it("does not normalize canonically equivalent Unicode passwords", async () => {
    const composed = `${"é".repeat(6)}abcdef`;
    const decomposed = `${"e\u0301".repeat(6)}abcdef`;
    const hash = await hashPassword(composed, 12);

    expect(composed.normalize("NFD")).toBe(decomposed);
    await expect(verifyPassword(composed, hash)).resolves.toBe(true);
    await expect(verifyPassword(decomposed, hash)).resolves.toBe(false);
  });

  it("enforces the approved minimum bcrypt cost", async () => {
    await expect(hashPassword("synthetic-password", 11)).rejects.toThrow("Bcrypt cost");
  });

  it("rejects new password hashes shorter than the provisioning policy", async () => {
    await expect(hashPassword("short", 12)).rejects.toBeInstanceOf(InvalidPasswordInputError);
  });
});
