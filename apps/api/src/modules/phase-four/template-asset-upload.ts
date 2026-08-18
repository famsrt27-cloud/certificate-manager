import { posix, win32 } from "node:path";

import sharp from "sharp";

import { ApplicationError } from "../../errors/application-error.js";

const IMAGE_MAX_DIMENSION = 4_096;
const IMAGE_MAX_PIXELS = 16_000_000;
const FONT_MAX_TABLES = 128;
const allowedDeclaredMimeTypes = new Set([
  "image/png", "image/jpeg", "font/ttf", "font/otf", "application/x-font-ttf", "application/x-font-opentype"
]);

const reject = (): never => {
  throw new ApplicationError("UPLOAD_REJECTED", "The uploaded file could not be accepted.", 400);
};

const detectMimeType = (bytes: Uint8Array): "image/png" | "image/jpeg" | "font/ttf" | "font/otf" => {
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const signature = Buffer.from(bytes.subarray(0, 4)).toString("latin1");
  if (signature === "OTTO") return "font/otf";
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) return "font/ttf";
  return reject();
};

const validateFontStructure = (bytes: Uint8Array): void => {
  if (bytes.length < 12) reject();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tableCount = view.getUint16(4, false);
  if (tableCount === 0 || tableCount > FONT_MAX_TABLES || 12 + tableCount * 16 > bytes.length) reject();
  const tags = new Set<string>();
  for (let index = 0; index < tableCount; index += 1) {
    const offset = 12 + index * 16;
    const tag = Buffer.from(bytes.subarray(offset, offset + 4)).toString("latin1");
    const tableOffset = view.getUint32(offset + 8, false);
    const tableLength = view.getUint32(offset + 12, false);
    if (!/^[\x20-\x7E]{4}$/.test(tag) || tags.has(tag) || tableLength === 0 || tableOffset > bytes.length
      || tableLength > bytes.length - tableOffset) reject();
    tags.add(tag);
  }
  if (!tags.has("head") || !tags.has("name") || !tags.has("maxp")) reject();
};

const normalizeFilename = (filename: string, mimeType: string): string => {
  const basename = posix.basename(win32.basename(filename.normalize("NFKC"))).replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "").slice(0, 200);
  const extension = mimeType === "image/png" ? ".png" : mimeType === "image/jpeg" ? ".jpg" : mimeType === "font/ttf" ? ".ttf" : ".otf";
  const stem = basename.replace(/\.[^.]*$/, "").slice(0, 190) || "asset";
  return `${stem}${extension}`;
};

export interface ValidatedTemplateAssetUpload {
  readonly originalFilename: string;
  readonly detectedMimeType: "image/png" | "image/jpeg" | "font/ttf" | "font/otf";
  readonly widthPx: number | null;
  readonly heightPx: number | null;
}

export const validateTemplateAssetUpload = async (input: {
  readonly filename: string; readonly declaredMimeType: string; readonly bytes: Uint8Array;
}): Promise<ValidatedTemplateAssetUpload> => {
  if (!allowedDeclaredMimeTypes.has(input.declaredMimeType)) return reject();
  const detectedMimeType = detectMimeType(input.bytes);
  const declaredMatches = input.declaredMimeType === detectedMimeType
    || (detectedMimeType === "font/ttf" && input.declaredMimeType === "application/x-font-ttf")
    || (detectedMimeType === "font/otf" && input.declaredMimeType === "application/x-font-opentype");
  if (!declaredMatches) return reject();
  let widthPx: number | null = null;
  let heightPx: number | null = null;
  if (detectedMimeType.startsWith("image/")) {
    try {
      const metadata = await sharp(input.bytes, { animated: false, failOn: "error", limitInputPixels: IMAGE_MAX_PIXELS })
        .metadata();
      if (metadata.pages !== undefined && metadata.pages !== 1) return reject();
      if (metadata.width === undefined || metadata.height === undefined || metadata.width > IMAGE_MAX_DIMENSION
        || metadata.height > IMAGE_MAX_DIMENSION || metadata.width * metadata.height > IMAGE_MAX_PIXELS) return reject();
      widthPx = metadata.width;
      heightPx = metadata.height;
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      return reject();
    }
  } else {
    validateFontStructure(input.bytes);
  }
  return { originalFilename: normalizeFilename(input.filename, detectedMimeType), detectedMimeType, widthPx, heightPx };
};
