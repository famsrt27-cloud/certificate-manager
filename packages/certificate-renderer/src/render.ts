import PDFDocument from "pdfkit";
import QRCode from "qrcode";

import { bindTemplate, logicalPixelsToPdfPoints } from "@certificate-platform/template-engine";

import { getBundledFont } from "./bundled-fonts.js";
import {
  LEGACY_CERTIFICATE_RENDERER_REVISION,
  prepareCertificateRenderInput,
  type CertificateRenderBoundaryOptions
} from "./render-input.js";

export interface CertificatePdfRenderOptions extends CertificateRenderBoundaryOptions {
  readonly maxPdfBytes: number;
}

const fixedCreationDate = new Date("2000-01-01T00:00:00.000Z");

const imageOptions = (fit: "contain" | "cover" | "fill", width: number, height: number) =>
  fit === "fill" ? { width, height } : fit === "cover"
    ? { width, height, cover: [width, height] as [number, number] }
    : { width, height, fit: [width, height] as [number, number], align: "center" as const, valign: "center" as const };

export const renderCertificatePdf = async (untrustedInput: unknown, options: CertificatePdfRenderOptions): Promise<Uint8Array> => {
  if (!Number.isSafeInteger(options.maxPdfBytes) || options.maxPdfBytes < 1) throw new Error("maxPdfBytes must be positive");
  const input = prepareCertificateRenderInput(untrustedInput, options);
  const point = input.rendererRevision === LEGACY_CERTIFICATE_RENDERER_REVISION
    ? (value: number): number => value
    : logicalPixelsToPdfPoints;
  const assets = new Map(input.assets.map((asset) => [asset.id, asset]));
  const bound = bindTemplate(input.templateDefinition, input.bindings);
  const chunks: Buffer[] = [];
  let outputBytes = 0;
  let outputLimitExceeded = false;
  const document = new PDFDocument({
    size: [point(input.templateDefinition.page.width), point(input.templateDefinition.page.height)],
    margin: 0,
    autoFirstPage: true,
    info: { CreationDate: fixedCreationDate, ModDate: fixedCreationDate,
      Producer: `certificate-platform/${input.rendererRevision}` }
  });
  const controlledDocument = document as typeof document & { readonly destroyed: boolean; destroy(error?: Error): void };
  document.on("data", (chunk: Buffer) => {
    outputBytes += chunk.byteLength;
    if (outputBytes > options.maxPdfBytes) {
      outputLimitExceeded = true;
      controlledDocument.destroy(new Error("renderer PDF byte budget exceeded"));
      return;
    }
    chunks.push(Buffer.from(chunk));
  });
  const completed = new Promise<void>((resolve, reject) => { document.once("end", resolve); document.once("error", reject); });

  try {
    for (const [index, element] of input.templateDefinition.elements.entries()) {
      document.save();
      document.opacity(element.opacity);
      if (element.type === "text") {
        const asset = element.font.asset_id === undefined ? undefined : assets.get(element.font.asset_id);
        const font = asset === undefined ? getBundledFont(element.font.family, element.font.weight) : { bytes: asset.bytes };
        if (font === undefined) throw new Error("unsupported font without a bundled or uploaded asset");
        document.font(Buffer.from(font.bytes)).fontSize(point(element.font.size)).fillColor(element.color);
        document.text(bound[index]?.value ?? "", point(element.x), point(element.y), {
          width: point(element.width), height: point(element.height), align: element.align
        });
      } else if (element.type === "image" || element.type === "signature") {
        const asset = assets.get(element.asset_id);
        if (asset === undefined || asset.kind !== "IMAGE") throw new Error("required image asset is unavailable");
        document.image(Buffer.from(asset.bytes), point(element.x), point(element.y),
          imageOptions(element.type === "signature" ? "contain" : element.fit, point(element.width), point(element.height)));
      } else if (element.type === "qr") {
        const png = await QRCode.toBuffer(input.bindings.verificationUrl, { type: "png", errorCorrectionLevel: "M", color: { dark: element.foreground, light: element.background } });
        document.image(png, point(element.x), point(element.y), { width: point(element.width), height: point(element.height) });
      } else if (element.shape === "line") {
        document.moveTo(point(element.x), point(element.y)).lineTo(point(element.x + element.width), point(element.y + element.height))
          .lineWidth(point(element.stroke_width)).strokeColor(element.color).stroke();
      } else {
        document.lineWidth(point(element.stroke_width)).strokeColor(element.color)
          .rect(point(element.x), point(element.y), point(element.width), point(element.height)).stroke();
      }
      document.restore();
    }
    document.end();
    await completed;
  } catch (error) {
    if (!controlledDocument.destroyed) controlledDocument.destroy(error instanceof Error ? error : new Error("renderer failed"));
    await completed.catch(() => undefined);
    throw error;
  }
  const pdf = Buffer.concat(chunks);
  if (outputLimitExceeded || pdf.byteLength === 0 || pdf.byteLength > options.maxPdfBytes
    || !pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("renderer produced an invalid PDF");
  return new Uint8Array(pdf);
};
