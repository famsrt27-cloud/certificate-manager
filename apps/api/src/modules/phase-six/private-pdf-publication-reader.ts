import { createHash, timingSafeEqual } from "node:crypto";

import type { CertificateStatus } from "@certificate-platform/database";
import type { PrivateObjectStorage } from "@certificate-platform/storage";

const MAX_STORAGE_KEY_BYTES = 2_048;

export interface PrivatePdfPublicationRecord {
  readonly status: CertificateStatus;
  readonly pdfStorageKey: string | null;
  readonly pdfContentSha256: Uint8Array | null;
  readonly pdfSizeBytes: string | null;
  readonly pdfMimeType: string | null;
  readonly generationRevision: number;
}

interface ValidPublication {
  readonly storageKey: string;
  readonly contentSha256: Uint8Array;
  readonly sizeBytes: number;
  readonly mimeType: "application/pdf";
  readonly generationRevision: number;
}

export class PrivatePdfPublicationReadError extends Error {
  constructor() {
    super("Private PDF publication could not be read");
    this.name = "PrivatePdfPublicationReadError";
  }
}

const validatePublication = (
  record: PrivatePdfPublicationRecord | null,
  maximumPdfBytes: number
): ValidPublication | null => {
  if (record === null || record.status !== "AVAILABLE" || record.pdfStorageKey === null
    || record.pdfContentSha256 === null || record.pdfSizeBytes === null
    || record.pdfMimeType !== "application/pdf" || !Number.isSafeInteger(record.generationRevision)
    || record.generationRevision < 1) return null;
  const storageKeyBytes = Buffer.byteLength(record.pdfStorageKey, "utf8");
  if (storageKeyBytes < 1 || storageKeyBytes > MAX_STORAGE_KEY_BYTES || record.pdfContentSha256.byteLength !== 32) {
    return null;
  }
  let sizeBigInt: bigint;
  try {
    sizeBigInt = BigInt(record.pdfSizeBytes);
  } catch {
    return null;
  }
  if (sizeBigInt <= 0n || sizeBigInt > BigInt(maximumPdfBytes)
    || sizeBigInt > BigInt(Number.MAX_SAFE_INTEGER) || sizeBigInt.toString() !== record.pdfSizeBytes) return null;
  return {
    storageKey: record.pdfStorageKey,
    contentSha256: new Uint8Array(record.pdfContentSha256),
    sizeBytes: Number(sizeBigInt),
    mimeType: "application/pdf",
    generationRevision: record.generationRevision
  };
};

const publicationMatches = (first: ValidPublication, second: ValidPublication): boolean =>
  first.storageKey === second.storageKey
  && first.sizeBytes === second.sizeBytes
  && first.mimeType === second.mimeType
  && first.generationRevision === second.generationRevision
  && timingSafeEqual(Buffer.from(first.contentSha256), Buffer.from(second.contentSha256));

export const readPrivatePdfPublication = async <Record extends PrivatePdfPublicationRecord>(options: {
  readonly loadPublication: () => Promise<Record | null>;
  readonly storage: Pick<PrivateObjectStorage, "get">;
  readonly maximumPdfBytes: number;
}): Promise<{ readonly bytes: Uint8Array; readonly record: Record }> => {
  if (!Number.isSafeInteger(options.maximumPdfBytes) || options.maximumPdfBytes < 1) {
    throw new Error("Private PDF publication size limit is invalid");
  }
  try {
    const initialRecord = await options.loadPublication();
    const publication = validatePublication(initialRecord, options.maximumPdfBytes);
    if (initialRecord === null || publication === null) throw new PrivatePdfPublicationReadError();

    const bytes = await options.storage.get(publication.storageKey, options.maximumPdfBytes);
    if (bytes.byteLength !== publication.sizeBytes
      || Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-") {
      throw new PrivatePdfPublicationReadError();
    }
    const actualHash = createHash("sha256").update(bytes).digest();
    if (!timingSafeEqual(actualHash, Buffer.from(publication.contentSha256))) {
      throw new PrivatePdfPublicationReadError();
    }

    const finalPublication = validatePublication(await options.loadPublication(), options.maximumPdfBytes);
    if (finalPublication === null || !publicationMatches(publication, finalPublication)) {
      throw new PrivatePdfPublicationReadError();
    }
    return { bytes: new Uint8Array(bytes), record: initialRecord };
  } catch (error) {
    if (error instanceof PrivatePdfPublicationReadError) throw error;
    throw new PrivatePdfPublicationReadError();
  }
};
