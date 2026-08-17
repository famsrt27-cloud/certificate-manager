import { extname, posix } from "node:path";

import { ApplicationError } from "../../errors/application-error.js";

const CSV_MIME_TYPES = new Set(["text/csv", "application/csv"]);
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface ValidatedParticipantImportUpload {
  readonly originalFilename: string;
  readonly detectedMimeType: "text/csv" | typeof XLSX_MIME_TYPE;
}

const normalizeFilename = (filename: string): string => {
  const normalized = [...posix.basename(filename.replaceAll("\\", "/")).normalize("NFC")]
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join("").trim();
  if (normalized.length === 0 || normalized.length > 255) {
    throw new ApplicationError("UPLOAD_REJECTED", "The uploaded file could not be accepted.", 400);
  }
  return normalized;
};

const isXlsxSignature = (bytes: Uint8Array): boolean => bytes.length >= 4
  && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

const isUtf8Csv = (bytes: Uint8Array): boolean => {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
};

export const validateParticipantImportUpload = (
  filename: string,
  declaredMimeType: string,
  bytes: Uint8Array
): ValidatedParticipantImportUpload => {
  if (bytes.byteLength === 0) throw new ApplicationError("UPLOAD_REJECTED", "The uploaded file could not be accepted.", 400);
  const originalFilename = normalizeFilename(filename);
  const extension = extname(originalFilename).toLowerCase();
  if (extension === ".csv" && CSV_MIME_TYPES.has(declaredMimeType.toLowerCase()) && isUtf8Csv(bytes)) {
    return { originalFilename, detectedMimeType: "text/csv" };
  }
  if (extension === ".xlsx" && declaredMimeType.toLowerCase() === XLSX_MIME_TYPE && isXlsxSignature(bytes)) {
    return { originalFilename, detectedMimeType: XLSX_MIME_TYPE };
  }
  throw new ApplicationError("UPLOAD_REJECTED", "The uploaded file could not be accepted.", 400);
};
