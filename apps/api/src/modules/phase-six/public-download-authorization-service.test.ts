import { createCertificateVerificationToken, verifyCertificateDownloadToken } from "@certificate-platform/domain";
import { describe, expect, it, vi } from "vitest";

import { PublicDownloadAuthorizationFailureError,
  PublicDownloadAuthorizationService } from "./public-download-authorization-service.js";

const activeKey = Buffer.alloc(32, 31);
const previousKey = Buffer.alloc(32, 32);
const publicIdentifier = "abcdef0123456789abcdef0123456789";
const issuedAt = new Date("2026-08-26T10:00:00.000Z");
const verificationToken = createCertificateVerificationToken({ keyId: "previous-key", key: previousKey,
  publicIdentifier, issuedAt: new Date("2026-08-25T00:00:00.000Z") });
const published = { status: "AVAILABLE" as const, pdfStorageKey: "certificates/private/1.pdf",
  pdfContentSha256: Buffer.alloc(32, 9), pdfSizeBytes: "128", pdfMimeType: "application/pdf" };

const createService = (record: unknown = published) => {
  const findByPublicIdentifier = vi.fn().mockResolvedValue(record);
  const service = new PublicDownloadAuthorizationService({ verificationKeys: new Map([["active-key", activeKey],
    ["previous-key", previousKey]]), activeSigningKeyId: "active-key", activeSigningKey: activeKey,
  repository: { findByPublicIdentifier }, ttlSeconds: 45, now: () => issuedAt });
  return { service, findByPublicIdentifier };
};

describe("PublicDownloadAuthorizationService", () => {
  it("authenticates with a retained key and mints an ephemeral token using the active key", async () => {
    const { service, findByPublicIdentifier } = createService();
    const result = await service.authorize(verificationToken);
    expect(result.expires_in).toBe(45);
    expect(result.download_token).not.toBe(verificationToken);
    expect(verifyCertificateDownloadToken(result.download_token, new Map([["active-key", activeKey]]))).toEqual({
      publicIdentifier, issuedAtSeconds: 1_787_738_400, expiresAtSeconds: 1_787_738_445,
      tokenId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/)
    });
    expect(findByPublicIdentifier).toHaveBeenCalledWith(publicIdentifier);
    expect(result).not.toHaveProperty("pdfStorageKey");
  });

  it("does not query or mint before verification signature authentication", async () => {
    const { service, findByPublicIdentifier } = createService();
    const segments = verificationToken.split(".");
    const signature = Buffer.from(segments[2]!, "base64url");
    signature[0] = signature[0]! ^ 1;
    await expect(service.authorize(`${segments[0]}.${segments[1]}.${signature.toString("base64url")}`))
      .rejects.toBeInstanceOf(PublicDownloadAuthorizationFailureError);
    expect(findByPublicIdentifier).not.toHaveBeenCalled();
  });

  it.each(["DRAFT", "GENERATING", "ISSUED", "REVOKED", "ARCHIVED"] as const)("rejects current state %s", async (status) => {
    const { service } = createService({ ...published, status });
    await expect(service.authorize(verificationToken)).rejects.toBeInstanceOf(PublicDownloadAuthorizationFailureError);
  });

  it.each([
    null,
    { ...published, pdfStorageKey: null }, { ...published, pdfStorageKey: "" },
    { ...published, pdfStorageKey: "x".repeat(2_049) }, { ...published, pdfContentSha256: null },
    { ...published, pdfContentSha256: Buffer.alloc(31) }, { ...published, pdfSizeBytes: null },
    { ...published, pdfSizeBytes: "0" }, { ...published, pdfSizeBytes: "-1" }, { ...published, pdfSizeBytes: "1.5" },
    { ...published, pdfSizeBytes: String(BigInt(Number.MAX_SAFE_INTEGER) + 1n) },
    { ...published, pdfMimeType: "application/octet-stream" }
  ])("rejects missing or invalid publication metadata %#", async (record) => {
    const { service } = createService(record);
    await expect(service.authorize(verificationToken)).rejects.toBeInstanceOf(PublicDownloadAuthorizationFailureError);
  });
});
