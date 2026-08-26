import { createHash } from "node:crypto";

import { createCertificateDownloadToken, createCertificateVerificationToken } from "@certificate-platform/domain";
import { describe, expect, it, vi } from "vitest";

import { PublicCertificateDownloadFailureError,
  PublicCertificateDownloadService } from "./public-certificate-download-service.js";

const activeKey = Buffer.alloc(32, 41);
const previousKey = Buffer.alloc(32, 42);
const keys = new Map<string, Uint8Array>([["active-key", activeKey], ["previous-key", previousKey]]);
const publicIdentifier = "abcdef0123456789abcdef0123456789";
const now = new Date("2026-08-26T10:00:30.000Z");
const pdf = Buffer.from("%PDF-1.7\nsecure synthetic certificate\n%%EOF", "ascii");
const published = {
  status: "AVAILABLE" as const,
  pdfStorageKey: "certificates/private/revision-1.pdf",
  pdfContentSha256: createHash("sha256").update(pdf).digest(),
  pdfSizeBytes: String(pdf.byteLength),
  pdfMimeType: "application/pdf",
  generationRevision: 1
};

const tokenFor = (keyId = "active-key", key = activeKey, issuedAt = new Date("2026-08-26T10:00:00.000Z"),
  ttlSeconds = 60) => createCertificateDownloadToken({ keyId, key, publicIdentifier, issuedAt, ttlSeconds,
  tokenId: Buffer.alloc(16, 8).toString("base64url") });

const createService = (records: readonly unknown[] = [published, published], bytes: Uint8Array = pdf) => {
  const findByPublicIdentifier = vi.fn();
  for (const record of records) findByPublicIdentifier.mockResolvedValueOnce(record);
  const get = vi.fn().mockResolvedValue(bytes);
  const service = new PublicCertificateDownloadService({ verificationKeys: keys,
    repository: { findByPublicIdentifier }, storage: { get }, maximumPdfBytes: 1_024, now: () => now });
  return { service, findByPublicIdentifier, get };
};

describe("PublicCertificateDownloadService", () => {
  it.each([
    ["active-key", activeKey],
    ["previous-key", previousKey]
  ] as const)("redeems a currently valid token signed by %s after exact integrity and final publication checks",
    async (keyId, key) => {
      const { service, findByPublicIdentifier, get } = createService();
      await expect(service.download(tokenFor(keyId, key))).resolves.toEqual(new Uint8Array(pdf));
      expect(findByPublicIdentifier).toHaveBeenCalledTimes(2);
      expect(findByPublicIdentifier).toHaveBeenNthCalledWith(1, publicIdentifier);
      expect(get).toHaveBeenCalledWith(published.pdfStorageKey, 1_024);
    });

  it("authenticates the signature before querying PostgreSQL or storage", async () => {
    const { service, findByPublicIdentifier, get } = createService();
    const token = tokenFor();
    const segments = token.split(".");
    const signature = Buffer.from(segments[2]!, "base64url");
    signature[0] = signature[0]! ^ 1;
    await expect(service.download(`${segments[0]}.${segments[1]}.${signature.toString("base64url")}`))
      .rejects.toBeInstanceOf(PublicCertificateDownloadFailureError);
    expect(findByPublicIdentifier).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    ["expired", new Date("2026-08-26T09:59:30.000Z"), 60],
    ["expiry boundary", new Date("2026-08-26T09:59:30.000Z"), 60],
    ["future issued", new Date("2026-08-26T10:00:31.000Z"), 29]
  ] as const)("rejects %s tokens before PostgreSQL and storage", async (name, issuedAt, ttlSeconds) => {
    const { findByPublicIdentifier, get } = createService();
    const redemptionNow = name === "expired" ? new Date("2026-08-26T10:00:31.000Z") : now;
    const timedService = new PublicCertificateDownloadService({ verificationKeys: keys,
      repository: { findByPublicIdentifier }, storage: { get }, maximumPdfBytes: 1_024, now: () => redemptionNow });
    await expect(timedService.download(tokenFor("active-key", activeKey, issuedAt, ttlSeconds)))
      .rejects.toBeInstanceOf(PublicCertificateDownloadFailureError);
    expect(findByPublicIdentifier).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("does not accept a verification token as a download token", async () => {
    const { service, findByPublicIdentifier, get } = createService();
    const verificationToken = createCertificateVerificationToken({ keyId: "active-key", key: activeKey,
      publicIdentifier, issuedAt: now });
    await expect(service.download(verificationToken)).rejects.toBeInstanceOf(PublicCertificateDownloadFailureError);
    expect(findByPublicIdentifier).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it.each(["DRAFT", "GENERATING", "ISSUED", "REVOKED", "ARCHIVED"] as const)(
    "checks current %s state before private storage", async (status) => {
      const { service, get } = createService([{ ...published, status }]);
      await expect(service.download(tokenFor())).rejects.toBeInstanceOf(PublicCertificateDownloadFailureError);
      expect(get).not.toHaveBeenCalled();
    });

  it.each([
    null,
    { ...published, pdfStorageKey: null }, { ...published, pdfStorageKey: "" },
    { ...published, pdfStorageKey: "x".repeat(2_049) },
    { ...published, pdfContentSha256: null }, { ...published, pdfContentSha256: Buffer.alloc(31) },
    { ...published, pdfSizeBytes: null }, { ...published, pdfSizeBytes: "0" },
    { ...published, pdfSizeBytes: "01" }, { ...published, pdfSizeBytes: "1025" },
    { ...published, pdfMimeType: "application/octet-stream" }, { ...published, generationRevision: 0 }
  ])("rejects incomplete or unsafe database publication metadata before storage %#", async (record) => {
    const { service, get } = createService([record]);
    await expect(service.download(tokenFor())).rejects.toBeInstanceOf(PublicCertificateDownloadFailureError);
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong size", Buffer.concat([pdf, Buffer.from("x")])],
    ["wrong SHA-256", Buffer.from("%PDF-1.7\ndifferent but same-ish", "ascii")],
    ["missing PDF signature", Buffer.from(pdf.toString("ascii").replace("%PDF-", "%PDX-"), "ascii")]
  ] as const)("blocks %s before success", async (_name, bytes) => {
    const record = { ...published, pdfSizeBytes: String(bytes.byteLength) };
    const { service } = createService([record], bytes);
    await expect(service.download(tokenFor())).rejects.toBeInstanceOf(PublicCertificateDownloadFailureError);
  });

  it.each(["missing object", "object too large", "storage unavailable"])("maps %s storage failures generically", async () => {
    const { service, get } = createService([published]);
    get.mockRejectedValueOnce(new Error("private storage detail certificates/secret.pdf"));
    await expect(service.download(tokenFor())).rejects.toEqual(new PublicCertificateDownloadFailureError());
  });

  it("blocks revocation during retrieval with a final state check", async () => {
    const { service } = createService([published, { ...published, status: "REVOKED" }]);
    await expect(service.download(tokenFor())).rejects.toBeInstanceOf(PublicCertificateDownloadFailureError);
  });

  it.each([
    { ...published, pdfStorageKey: "certificates/private/revision-2.pdf" },
    { ...published, pdfContentSha256: Buffer.alloc(32, 7) },
    { ...published, pdfSizeBytes: String(pdf.byteLength + 1) },
    { ...published, generationRevision: 2 }
  ])("blocks stale publication changes during retrieval %#", async (changed) => {
    const { service } = createService([published, changed]);
    await expect(service.download(tokenFor())).rejects.toBeInstanceOf(PublicCertificateDownloadFailureError);
  });
});
