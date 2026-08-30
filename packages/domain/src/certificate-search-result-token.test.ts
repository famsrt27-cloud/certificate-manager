import { createCertificateDownloadToken, verifyCertificateDownloadTokenForRedemption } from "./certificate-download-token.js";
import { createCertificateVerificationToken, verifyCertificateVerificationToken } from "./certificate-verification-token.js";
import { createCertificateSearchResultToken, InvalidCertificateSearchResultTokenError,
  verifyCertificateSearchResultToken } from "./certificate-search-result-token.js";
import { describe, expect, it } from "vitest";

const key = Buffer.alloc(32, 21);
const keys = new Map<string, Uint8Array>([["search-key", key]]);
const publicIdentifier = "a".repeat(32);
const issuedAt = new Date("2026-08-30T10:00:00.000Z");

describe("certificate search result token", () => {
  it("issues a distinct certificate-scoped short-lived capability", () => {
    const token = createCertificateSearchResultToken({ keyId: "search-key", key, publicIdentifier,
      issuedAt, ttlSeconds: 180, tokenId: Buffer.alloc(16, 7).toString("base64url") });
    expect(token).not.toContain(publicIdentifier);
    expect(verifyCertificateSearchResultToken(token, keys, new Date("2026-08-30T10:02:59.000Z")))
      .toMatchObject({ publicIdentifier, expiresAtSeconds: Math.floor(issuedAt.getTime() / 1_000) + 180 });
  });

  it("rejects expiry, tampering, and other token domains", () => {
    const token = createCertificateSearchResultToken({ keyId: "search-key", key, publicIdentifier,
      issuedAt, ttlSeconds: 180 });
    expect(() => verifyCertificateSearchResultToken(token, keys, new Date("2026-08-30T10:03:00.000Z")))
      .toThrow(InvalidCertificateSearchResultTokenError);
    expect(() => verifyCertificateSearchResultToken(`${token.slice(0, -1)}x`, keys, issuedAt))
      .toThrow(InvalidCertificateSearchResultTokenError);
    const verificationToken = createCertificateVerificationToken({ keyId: "search-key", key,
      publicIdentifier, issuedAt });
    const downloadToken = createCertificateDownloadToken({ keyId: "search-key", key, publicIdentifier,
      issuedAt, ttlSeconds: 60 });
    expect(() => verifyCertificateSearchResultToken(verificationToken, keys, issuedAt))
      .toThrow(InvalidCertificateSearchResultTokenError);
    expect(() => verifyCertificateSearchResultToken(downloadToken, keys, issuedAt))
      .toThrow(InvalidCertificateSearchResultTokenError);
    expect(() => verifyCertificateVerificationToken(token, keys)).toThrow();
    expect(() => verifyCertificateDownloadTokenForRedemption(token, keys, issuedAt)).toThrow();
  });
});
