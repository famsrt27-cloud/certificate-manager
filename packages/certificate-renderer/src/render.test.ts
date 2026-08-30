import { createHash, randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";
import PDFDocument from "pdfkit";
import { pageForCustomMillimeters, pageForPreset } from "@certificate-platform/template-engine";

import { CERTIFICATE_RENDERER_REVISION, LEGACY_CERTIFICATE_RENDERER_REVISION, MAX_VERIFICATION_URL_BYTES } from "./render-input.js";
import { renderCertificatePdf } from "./render.js";

const baseInput = (elements: readonly Record<string, unknown>[] = [], verificationUrl = "https://verify.example.invalid/verify#token=synthetic") => ({
  inputVersion: 1,
  rendererRevision: CERTIFICATE_RENDERER_REVISION as typeof CERTIFICATE_RENDERER_REVISION
    | typeof LEGACY_CERTIFICATE_RENDERER_REVISION,
  templateDefinition: { format_version: 1, page: { width: 500, height: 300, unit: "px" }, elements },
  bindings: {
    recipient: { displayName: "Synthetic Recipient" }, project: { name: "Synthetic Project" },
    training: { name: "Synthetic Training", code: "SYNTH-001" },
    certificate: { number: "CERT-SYNTH-001", issuedAt: "2026-08-24" }, verificationUrl
  },
  assets: [] as Record<string, unknown>[]
});

const textElement = (text: string) => ({
  type: "text", x: 10, y: 10, width: 480, height: 100, opacity: 1, align: "left", color: "#000000",
  font: { family: "Noto Sans Thai", size: 18, weight: 400 }, text
});

const qrElement = { type: "qr", x: 350, y: 130, width: 120, height: 120, opacity: 1,
  binding: "verification_url", foreground: "#000000", background: "#FFFFFF" };

const asset = (id: string, kind: "IMAGE" | "FONT", mimeType: "image/png" | "font/ttf", bytes: Uint8Array) => ({
  id, kind, mimeType, contentSha256: new Uint8Array(createHash("sha256").update(bytes).digest()), bytes
});

afterEach(() => vi.unstubAllGlobals());

describe("certificate PDF renderer hardening", () => {
  it.each([
    ["A4 portrait", pageForPreset("A4", "PORTRAIT"), 210, 297],
    ["A4 landscape", pageForPreset("A4", "LANDSCAPE"), 297, 210],
    ["A5 portrait", pageForPreset("A5", "PORTRAIT"), 148, 210],
    ["A5 landscape", pageForPreset("A5", "LANDSCAPE"), 210, 148],
    ["B5 ISO", pageForPreset("B5_ISO", "PORTRAIT"), 176, 250],
    ["B5 JIS", pageForPreset("B5_JIS", "PORTRAIT"), 182, 257],
    ["custom", pageForCustomMillimeters(240, 180), 240, 180]
  ] as const)("renders the correct physical MediaBox for %s", async (_label, page, widthMm, heightMm) => {
    const input = baseInput(); input.templateDefinition.page = page;
    const pdf = Buffer.from(await renderCertificatePdf(input, { maxTotalAssetBytes: 1_024, maxPdfBytes: 1_000_000 }));
    const mediaBox = pdf.toString("latin1").match(/\/MediaBox\s*\[0 0 ([\d.]+) ([\d.]+)\]/);
    expect(Number(mediaBox?.[1])).toBeCloseTo(widthMm * 72 / 25.4, 1);
    expect(Number(mediaBox?.[2])).toBeCloseTo(heightMm * 72 / 25.4, 1);
  });

  it("maps logical 96-DPI pixels to physical PDF points while preserving legacy revision output", async () => {
    const a4 = baseInput();
    a4.templateDefinition.page = { width: 1122.519, height: 793.701, unit: "px" };
    const current = Buffer.from(await renderCertificatePdf(a4, { maxTotalAssetBytes: 1_024, maxPdfBytes: 1_000_000 }));
    const currentMediaBox = current.toString("latin1").match(/\/MediaBox\s*\[0 0 ([\d.]+) ([\d.]+)\]/);
    expect(Number(currentMediaBox?.[1])).toBeCloseTo(841.89, 1);
    expect(Number(currentMediaBox?.[2])).toBeCloseTo(595.28, 1);

    const legacy = baseInput();
    legacy.rendererRevision = LEGACY_CERTIFICATE_RENDERER_REVISION;
    const legacyPdf = Buffer.from(await renderCertificatePdf(legacy, { maxTotalAssetBytes: 1_024, maxPdfBytes: 1_000_000 }));
    const legacyMediaBox = legacyPdf.toString("latin1").match(/\/MediaBox\s*\[0 0 ([\d.]+) ([\d.]+)\]/);
    expect(Number(legacyMediaBox?.[1])).toBeCloseTo(500, 1);
    expect(Number(legacyMediaBox?.[2])).toBeCloseTo(300, 1);
  });

  it("draws elements sequentially so later definition entries are canonical front layers", async () => {
    const colors: string[] = [];
    const fill = vi.spyOn(PDFDocument.prototype, "fillColor").mockImplementation(function (...args: unknown[]) {
      if (typeof args[0] === "string") colors.push(args[0]);
      return this;
    });
    await renderCertificatePdf(baseInput([
      { ...textElement("Bottom"), color: "#112233" },
      { ...textElement("Top"), color: "#445566" }
    ]), { maxTotalAssetBytes: 1_024, maxPdfBytes: 1_000_000 });
    expect(colors).toEqual(["#112233", "#445566"]);
    fill.mockRestore();
  });

  it("renders a valid bounded PDF and enforces the exact incremental output boundary", async () => {
    const input = baseInput([textElement("Literal certificate text"), qrElement]);
    const pdf = await renderCertificatePdf(input, { maxTotalAssetBytes: 1_024, maxPdfBytes: 1_000_000 });
    expect(Buffer.from(pdf.subarray(0, 5)).toString("ascii")).toBe("%PDF-");
    await expect(renderCertificatePdf(input, { maxTotalAssetBytes: 1_024, maxPdfBytes: pdf.byteLength })).resolves.toHaveLength(pdf.byteLength);
    await expect(renderCertificatePdf(input, { maxTotalAssetBytes: 1_024, maxPdfBytes: pdf.byteLength - 1 }))
      .rejects.toThrow(/byte budget|invalid PDF/);
  });

  it("keeps suspicious literal text literal and never invokes ambient network access", async () => {
    const network = vi.fn(() => { throw new Error("renderer attempted network access"); });
    vi.stubGlobal("fetch", network);
    const payloads = ["<script>alert(1)</script>", "{{constructor.constructor('inert')()}}", "${process.env.SECRET}",
      "<%= inert %>", "javascript:inert", "file:///etc/passwd", "../../../../etc/passwd"];
    const pdf = await renderCertificatePdf(baseInput(payloads.map(textElement)), { maxTotalAssetBytes: 1_024, maxPdfBytes: 1_000_000 });
    expect(pdf.byteLength).toBeGreaterThan(0);
    expect(network).not.toHaveBeenCalled();
  });

  it("encodes the verification URL only as QR data and handles the maximum supported URL deterministically", async () => {
    const prefix = "https://verify.invalid/#";
    const verificationUrl = prefix + "a".repeat(MAX_VERIFICATION_URL_BYTES - Buffer.byteLength(prefix));
    const network = vi.fn(() => { throw new Error("QR rendering attempted a fetch"); });
    vi.stubGlobal("fetch", network);
    await expect(renderCertificatePdf(baseInput([qrElement], verificationUrl), { maxTotalAssetBytes: 1_024, maxPdfBytes: 1_000_000 }))
      .resolves.toEqual(expect.any(Uint8Array));
    expect(network).not.toHaveBeenCalled();
  });

  it("contains malformed image and structurally passing malformed font failures without returning a partial PDF", async () => {
    const imageId = randomUUID();
    const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const imageInput = baseInput([{ type: "image", x: 10, y: 10, width: 20, height: 20, opacity: 1,
      asset_id: imageId, fit: "contain" }]);
    imageInput.assets = [asset(imageId, "IMAGE", "image/png", imageBytes)];
    await expect(renderCertificatePdf(imageInput, { maxTotalAssetBytes: 1_024, maxPdfBytes: 1_000_000 })).rejects.toThrow();

    const fontId = randomUUID();
    const fontBytes = Buffer.alloc(63);
    fontBytes.set([0, 1, 0, 0], 0);
    fontBytes.writeUInt16BE(3, 4);
    for (const [index, tag] of ["head", "name", "maxp"].entries()) {
      const offset = 12 + index * 16;
      fontBytes.write(tag, offset, 4, "latin1");
      fontBytes.writeUInt32BE(60, offset + 8);
      fontBytes.writeUInt32BE(1, offset + 12);
    }
    const fontInput = baseInput([{ ...textElement("Malformed font"), font: { family: "Private Font", asset_id: fontId, size: 18, weight: 400 } }]);
    fontInput.assets = [asset(fontId, "FONT", "font/ttf", fontBytes)];
    await expect(renderCertificatePdf(fontInput, { maxTotalAssetBytes: 1_024, maxPdfBytes: 1_000_000 })).rejects.toThrow();
  });

  it("rejects invalid output limit configuration before creating a PDF stream", async () => {
    await expect(renderCertificatePdf(baseInput(), { maxTotalAssetBytes: 1_024, maxPdfBytes: 0 })).rejects.toThrow("maxPdfBytes");
  });
});
