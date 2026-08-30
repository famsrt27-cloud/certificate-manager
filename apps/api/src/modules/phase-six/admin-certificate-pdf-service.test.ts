import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { AdminCertificatePdfService } from "./admin-certificate-pdf-service.js";

const pdf = Buffer.from("%PDF-1.7\nsynthetic\n%%EOF", "ascii");
const record = { certificateNumber: "CERT/000123 unsafe", status: "AVAILABLE" as const,
  pdfStorageKey: "private.pdf", pdfContentSha256: createHash("sha256").update(pdf).digest(),
  pdfSizeBytes: String(pdf.byteLength), pdfMimeType: "application/pdf", generationRevision: 1 };

describe("admin certificate PDF service", () => {
  it("keeps both reads tenant scoped and returns a sanitized non-PII filename", async () => {
    const findByOrganizationAndId = vi.fn().mockResolvedValue(record);
    const service = new AdminCertificatePdfService({ repository: { findByOrganizationAndId },
      storage: { get: vi.fn().mockResolvedValue(pdf) }, maximumPdfBytes: 1_024 });
    const result = await service.read("tenant-a", "certificate-a");
    expect(Buffer.from(result.bytes)).toEqual(pdf); expect(result.filename).toBe("certificate-CERT-000123-unsafe.pdf");
    expect(findByOrganizationAndId).toHaveBeenCalledTimes(2);
    expect(findByOrganizationAndId).toHaveBeenNthCalledWith(1, "tenant-a", "certificate-a");
    expect(findByOrganizationAndId).toHaveBeenNthCalledWith(2, "tenant-a", "certificate-a");
  });

  it("maps storage and publication failures to one detail-free admin error", async () => {
    const service = new AdminCertificatePdfService({ repository: { findByOrganizationAndId: vi.fn().mockResolvedValue(null) },
      storage: { get: vi.fn() }, maximumPdfBytes: 1_024 });
    await expect(service.read("tenant-a", "missing")).rejects.toEqual(expect.objectContaining({
      code: "NOT_FOUND", statusCode: 404, message: "The requested resource was not found."
    }));
  });
});
