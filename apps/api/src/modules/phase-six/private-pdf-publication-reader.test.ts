import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { PrivatePdfPublicationReadError, readPrivatePdfPublication } from "./private-pdf-publication-reader.js";

const pdf = Buffer.from("%PDF-1.7\nsynthetic admin certificate\n%%EOF", "ascii");
const available = {
  status: "AVAILABLE" as const,
  pdfStorageKey: "certificates/private/revision-1.pdf",
  pdfContentSha256: createHash("sha256").update(pdf).digest(),
  pdfSizeBytes: String(pdf.byteLength),
  pdfMimeType: "application/pdf",
  generationRevision: 1
};

const read = (records: unknown[], bytes: Uint8Array = pdf) => readPrivatePdfPublication({
  loadPublication: vi.fn().mockResolvedValueOnce(records[0]).mockResolvedValueOnce(records[1] ?? records[0]),
  storage: { get: vi.fn().mockResolvedValue(bytes) }, maximumPdfBytes: 1_024
});

describe("private PDF publication reader", () => {
  it("returns only a complete AVAILABLE PDF after the final publication check", async () => {
    const result = await read([available, available]);
    expect(Buffer.from(result.bytes)).toEqual(pdf); expect(result.record).toBe(available);
  });

  it.each(["DRAFT", "GENERATING", "ISSUED", "REVOKED", "ARCHIVED"] as const)("rejects %s state", async (status) => {
    await expect(read([{ ...available, status }])).rejects.toBeInstanceOf(PrivatePdfPublicationReadError);
  });

  it.each([
    { pdfStorageKey: null }, { pdfStorageKey: "" }, { pdfContentSha256: null },
    { pdfContentSha256: Buffer.alloc(31) }, { pdfSizeBytes: null }, { pdfSizeBytes: "0" },
    { pdfSizeBytes: "1025" }, { pdfSizeBytes: "01" }, { pdfMimeType: null },
    { pdfMimeType: "text/plain" }, { generationRevision: 0 }
  ])("rejects missing or invalid publication metadata %#", async (change) => {
    await expect(read([{ ...available, ...change }])).rejects.toBeInstanceOf(PrivatePdfPublicationReadError);
  });

  it("rejects missing, truncated, corrupt, and hash-mismatched objects", async () => {
    await expect(read([null])).rejects.toBeInstanceOf(PrivatePdfPublicationReadError);
    await expect(read([available], pdf.subarray(0, -1))).rejects.toBeInstanceOf(PrivatePdfPublicationReadError);
    await expect(read([available], Buffer.alloc(pdf.byteLength, 65))).rejects.toBeInstanceOf(PrivatePdfPublicationReadError);
    const differentPdf = Buffer.from(pdf); const lastIndex = differentPdf.byteLength - 1;
    differentPdf.writeUInt8(differentPdf.readUInt8(lastIndex) ^ 1, lastIndex);
    await expect(read([available], differentPdf)).rejects.toBeInstanceOf(PrivatePdfPublicationReadError);
  });

  it.each([
    { status: "REVOKED" as const }, { pdfStorageKey: "certificates/private/revision-2.pdf" },
    { generationRevision: 2 }, { pdfSizeBytes: String(pdf.byteLength + 1) },
    { pdfContentSha256: Buffer.alloc(32, 5) }
  ])("fails closed when publication changes after storage read %#", async (change) => {
    await expect(read([available, { ...available, ...change }])).rejects.toBeInstanceOf(PrivatePdfPublicationReadError);
  });
});
