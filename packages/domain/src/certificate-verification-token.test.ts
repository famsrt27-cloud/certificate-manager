import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CERTIFICATE_VERIFICATION_TOKEN_MAX_BYTES,
  InvalidCertificateVerificationTokenError,
  createCertificateVerificationToken,
  verifyCertificateVerificationToken
} from "./certificate-verification-token.js";

const activeKey = Buffer.alloc(32, 1);
const previousKey = Buffer.alloc(32, 2);
const keys = new Map<string, Uint8Array>([["active-key", activeKey], ["previous-key", previousKey]]);
const publicIdentifier = "0123456789abcdef0123456789abcdef";
const issuedAt = new Date("2026-08-25T00:00:00.000Z");

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const sign = (header: unknown, payload: unknown, key = activeKey): string => {
  const signed = `${encode(header)}.${encode(payload)}`;
  return `${signed}.${createHmac("sha256", key).update(signed).digest("base64url")}`;
};
const signSegments = (header: string, payload: string, key = activeKey): string => {
  const signed = `${header}.${payload}`;
  return `${signed}.${createHmac("sha256", key).update(signed).digest("base64url")}`;
};
const validHeader = { alg: "HS256", kid: "active-key", typ: "CVT" };
const validPayload = { v: 1, typ: "certificate-verification", pcid: publicIdentifier, iat: 1_777_248_000 };
const expectInvalid = (token: string): void => {
  expect(() => verifyCertificateVerificationToken(token, keys)).toThrow(InvalidCertificateVerificationTokenError);
};
const tamperSignature = (value: string): string => `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;

describe("certificate verification token validation", () => {
  it("verifies active and retained previous HS256 keys", () => {
    const active = createCertificateVerificationToken({ keyId: "active-key", key: activeKey, publicIdentifier, issuedAt });
    const previous = createCertificateVerificationToken({ keyId: "previous-key", key: previousKey, publicIdentifier, issuedAt });
    expect(verifyCertificateVerificationToken(active, keys)).toEqual({ publicIdentifier, issuedAtSeconds: 1_787_616_000 });
    expect(verifyCertificateVerificationToken(previous, keys)).toEqual({ publicIdentifier, issuedAtSeconds: 1_787_616_000 });
  });

  it("rejects payload, header, and signature tampering", () => {
    const token = createCertificateVerificationToken({ keyId: "active-key", key: activeKey, publicIdentifier, issuedAt });
    const [header, payload, signature] = token.split(".") as [string, string, string];
    expectInvalid(`${header}.${encode({ ...validPayload, pcid: "f".repeat(32) })}.${signature}`);
    expectInvalid(`${encode({ ...validHeader, kid: "previous-key" })}.${payload}.${signature}`);
    expectInvalid(tamperSignature(`${header}.${payload}.${signature}`));
  });

  it.each(["none", "HS384", "HS512", "RS256", "ES256"])("rejects algorithm %s", (alg) => {
    expectInvalid(sign({ ...validHeader, alg }, validPayload));
  });

  it.each(["jku", "jwk", "x5u"])("rejects protected header field %s", (field) => {
    expectInvalid(sign({ ...validHeader, [field]: "https://attacker.example.invalid/key" }, validPayload));
  });

  it("fails closed for unknown and removed keys", () => {
    const unknown = sign({ ...validHeader, kid: "unknown-key" }, validPayload);
    expectInvalid(unknown);
    const retained = createCertificateVerificationToken({ keyId: "previous-key", key: previousKey, publicIdentifier, issuedAt });
    expect(() => verifyCertificateVerificationToken(retained, new Map([["active-key", activeKey]])))
      .toThrow(InvalidCertificateVerificationTokenError);
  });

  it("rejects malformed structure, encoding, JSON, duplicates, and oversized tokens", () => {
    for (const token of ["", "one.two", "one.two.three.four", "*.e30.signature", `${encode("not-object")}.${encode(validPayload)}.x`,
      `${Buffer.from('{"alg":"HS256","alg":"HS256","kid":"active-key","typ":"CVT"}').toString("base64url")}.${encode(validPayload)}.x`,
      signSegments(encode(validHeader), Buffer.from(
        '{"v":1,"typ":"certificate-verification","pcid":"0123456789abcdef0123456789abcdef","pcid":"0123456789abcdef0123456789abcdef","iat":1777248000}'
      ).toString("base64url")),
      `${encode(validHeader)}=.${encode(validPayload)}.signature`,
      "a".repeat(CERTIFICATE_VERIFICATION_TOKEN_MAX_BYTES + 1)]) expectInvalid(token);
  });

  it.each([
    [{ ...validPayload, pcid: "A".repeat(32) }],
    [{ ...validPayload, pcid: "a".repeat(31) }],
    [{ ...validPayload, iat: -1 }],
    [{ ...validPayload, iat: 1.5 }],
    [{ ...validPayload, iat: Number.MAX_SAFE_INTEGER }],
    [{ ...validPayload, typ: "certificate-download" }],
    [{ ...validPayload, v: 2 }],
    [{ ...validPayload, pcid: "00000000-0000-4000-8000-000000000001" }],
    [{ ...validPayload, unexpected: true }]
  ])("rejects invalid payload claims", (payload) => expectInvalid(sign(validHeader, payload)));

  it.each([
    [{ ...validHeader, typ: "JWT" }],
    [{ ...validHeader, kid: "bad kid" }],
    [{ ...validHeader, kid: "" }]
  ])("rejects invalid protected header claims", (header) => expectInvalid(sign(header, validPayload)));
});
