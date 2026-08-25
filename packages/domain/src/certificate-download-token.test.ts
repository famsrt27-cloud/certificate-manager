import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createCertificateVerificationToken, verifyCertificateVerificationToken } from "./certificate-verification-token.js";
import { CERTIFICATE_DOWNLOAD_TOKEN_MAX_BYTES, InvalidCertificateDownloadTokenError,
  createCertificateDownloadToken, verifyCertificateDownloadToken } from "./certificate-download-token.js";

const activeKey = Buffer.alloc(32, 21);
const previousKey = Buffer.alloc(32, 22);
const keys = new Map<string, Uint8Array>([["active-key", activeKey], ["previous-key", previousKey]]);
const publicIdentifier = "0123456789abcdef0123456789abcdef";
const issuedAt = new Date("2026-08-26T00:00:00.000Z");
const tokenId = Buffer.alloc(16, 0).toString("base64url");
const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const sign = (header: unknown, payload: unknown, key = activeKey): string => {
  const signed = `${encode(header)}.${encode(payload)}`;
  return `${signed}.${createHmac("sha256", key).update(signed).digest("base64url")}`;
};
const validHeader = { alg: "HS256", kid: "active-key", typ: "CDT" };
const validPayload = { v: 1, typ: "certificate-download", aud: "public-certificate-download", pcid: publicIdentifier,
  iat: 1_787_702_400, exp: 1_787_702_460, jti: tokenId };
const expectInvalid = (token: string): void => {
  expect(() => verifyCertificateDownloadToken(token, keys)).toThrow(InvalidCertificateDownloadTokenError);
};
const tamperSignature = (token: string): string => {
  const segments = token.split(".");
  const signature = Buffer.from(segments[2]!, "base64url");
  signature[0] = signature[0]! ^ 1;
  return `${segments[0]}.${segments[1]}.${signature.toString("base64url")}`;
};

describe("certificate download token", () => {
  it("creates a pinned HS256 token with distinct type, audience, active kid, and bounded lifetime", () => {
    const token = createCertificateDownloadToken({ keyId: "active-key", key: activeKey, publicIdentifier,
      issuedAt, ttlSeconds: 60, tokenId });
    const [headerSegment, payloadSegment] = token.split(".");
    expect(JSON.parse(Buffer.from(headerSegment!, "base64url").toString("utf8"))).toEqual({ alg: "HS256",
      kid: "active-key", typ: "CDT" });
    expect(JSON.parse(Buffer.from(payloadSegment!, "base64url").toString("utf8"))).toEqual(validPayload);
    expect(verifyCertificateDownloadToken(token, keys)).toEqual({ publicIdentifier,
      issuedAtSeconds: validPayload.iat, expiresAtSeconds: validPayload.exp, tokenId });
  });

  it("uses retained keys for verification while new tokens use the selected active key", () => {
    const previous = createCertificateDownloadToken({ keyId: "previous-key", key: previousKey, publicIdentifier,
      issuedAt, ttlSeconds: 30, tokenId });
    expect(verifyCertificateDownloadToken(previous, keys).publicIdentifier).toBe(publicIdentifier);
    expect(() => verifyCertificateDownloadToken(previous, new Map([["active-key", activeKey]])))
      .toThrow(InvalidCertificateDownloadTokenError);
  });

  it("keeps verification and download token domains mutually exclusive", () => {
    const download = createCertificateDownloadToken({ keyId: "active-key", key: activeKey, publicIdentifier,
      issuedAt, ttlSeconds: 60, tokenId });
    const verification = createCertificateVerificationToken({ keyId: "active-key", key: activeKey,
      publicIdentifier, issuedAt });
    expect(() => verifyCertificateVerificationToken(download, keys)).toThrow();
    expect(() => verifyCertificateDownloadToken(verification, keys)).toThrow(InvalidCertificateDownloadTokenError);
  });

  it("generates a cryptographically random 128-bit token ID and binds it into the signature", () => {
    const generated = createCertificateDownloadToken({ keyId: "active-key", key: activeKey, publicIdentifier,
      issuedAt, ttlSeconds: 60 });
    const first = createCertificateDownloadToken({ keyId: "active-key", key: activeKey, publicIdentifier,
      issuedAt, ttlSeconds: 60, tokenId: Buffer.alloc(16, 1).toString("base64url") });
    const second = createCertificateDownloadToken({ keyId: "active-key", key: activeKey, publicIdentifier,
      issuedAt, ttlSeconds: 60, tokenId: Buffer.alloc(16, 2).toString("base64url") });
    expect(first).not.toBe(second);
    const payload = JSON.parse(Buffer.from(generated.split(".")[1]!, "base64url").toString("utf8")) as { jti: string };
    expect(Buffer.from(payload.jti, "base64url")).toHaveLength(16);
  });

  it.each([
    { publicIdentifier: "A".repeat(32) }, { keyId: "bad kid" }, { key: Buffer.alloc(31) }, { ttlSeconds: 0 },
    { ttlSeconds: 61 }, { ttlSeconds: 1.5 }, { issuedAt: new Date(Number.NaN) }, { tokenId: "" },
    { tokenId: "A".repeat(21) }, { tokenId: "B".repeat(22) }
  ])("rejects invalid creator input %#", (overrides) => {
    expect(() => createCertificateDownloadToken({ keyId: "active-key", key: activeKey, publicIdentifier,
      issuedAt, ttlSeconds: 60, tokenId, ...overrides })).toThrow();
  });

  it.each(["none", "HS384", "HS512", "RS256", "ES256"])("rejects algorithm %s", (alg) => {
    expectInvalid(sign({ ...validHeader, alg }, validPayload));
  });

  it.each(["jku", "jwk", "x5u"])("rejects protected header field %s", (field) => {
    expectInvalid(sign({ ...validHeader, [field]: "https://attacker.example.invalid/key" }, validPayload));
  });

  it.each([
    { typ: "certificate-verification" }, { aud: "another-audience" }, { v: 2 }, { pcid: "A".repeat(32) },
    { iat: -1 }, { exp: validPayload.iat }, { exp: validPayload.iat + 61 }, { jti: "short" }
  ])("rejects invalid payload claims %#", (overrides) => expectInvalid(sign(validHeader, { ...validPayload, ...overrides })));

  it("rejects malformed, unknown-key, tampered, and oversized tokens", () => {
    for (const token of ["", "one.two", "one.two.three.four", "*.e30.signature",
      sign({ ...validHeader, kid: "unknown-key" }, validPayload),
      tamperSignature(sign(validHeader, { ...validPayload, pcid: "f".repeat(32) })),
      "a".repeat(CERTIFICATE_DOWNLOAD_TOKEN_MAX_BYTES + 1)]) expectInvalid(token);
  });
});
