import { createCertificateVerificationToken } from "@certificate-platform/domain";
import { describe, expect, it, vi } from "vitest";

import { PublicVerificationFailureError, PublicVerificationService } from "./public-verification-service.js";

const key = Buffer.alloc(32, 7);
const publicIdentifier = "abcdef0123456789abcdef0123456789";
const token = createCertificateVerificationToken({ keyId: "active", key, publicIdentifier, issuedAt: new Date("2026-08-25T00:00:00Z") });
const tamperSignature = (value: string): string => {
  const segments = value.split(".");
  const signature = Buffer.from(segments[2]!, "base64url");
  signature[0] = signature[0]! ^ 0x01;
  return `${segments[0]}.${segments[1]}.${signature.toString("base64url")}`;
};

describe("PublicVerificationService", () => {
  it("does not query PostgreSQL before signature verification succeeds", async () => {
    const findByPublicIdentifier = vi.fn();
    const service = new PublicVerificationService({ verificationKeys: new Map([["active", key]]), repository: { findByPublicIdentifier } });
    await expect(service.verify(tamperSignature(token))).rejects.toBeInstanceOf(PublicVerificationFailureError);
    expect(findByPublicIdentifier).not.toHaveBeenCalled();
  });

  it("maps immutable snapshot data for available certificates", async () => {
    const findByPublicIdentifier = vi.fn().mockResolvedValue({ status: "AVAILABLE", certificateNumber: "CERT-001",
      recipientName: "Issuance Recipient", programName: "Issuance Program", issuedAt: new Date("2026-08-25T12:30:00Z") });
    const service = new PublicVerificationService({ verificationKeys: new Map([["active", key]]), repository: { findByPublicIdentifier } });
    await expect(service.verify(token)).resolves.toEqual({ status: "valid", certificate_number: "CERT-001",
      recipient_name: "Issuance Recipient", program_name: "Issuance Program", issued_at: "2026-08-25" });
    expect(findByPublicIdentifier).toHaveBeenCalledWith(publicIdentifier);
  });

  it("returns minimal revoked data and rejects non-public states", async () => {
    const repository = { findByPublicIdentifier: vi.fn().mockResolvedValue({ status: "REVOKED", certificateNumber: "CERT-002",
      recipientName: "Private", programName: "Private", issuedAt: new Date("2026-08-25T00:00:00Z") }) };
    const service = new PublicVerificationService({ verificationKeys: new Map([["active", key]]), repository });
    await expect(service.verify(token)).resolves.toEqual({ status: "revoked", certificate_number: "CERT-002" });
    repository.findByPublicIdentifier.mockResolvedValueOnce({ status: "GENERATING", certificateNumber: "CERT-002",
      recipientName: "Private", programName: "Private", issuedAt: new Date("2026-08-25T00:00:00Z") });
    await expect(service.verify(token)).rejects.toBeInstanceOf(PublicVerificationFailureError);
  });
});
