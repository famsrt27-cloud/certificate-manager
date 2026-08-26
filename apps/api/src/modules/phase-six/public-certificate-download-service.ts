import { createHash, timingSafeEqual } from "node:crypto";

import type { PublicCertificateDownloadRecord } from "@certificate-platform/database";
import { verifyCertificateDownloadTokenForRedemption } from "@certificate-platform/domain";
import type { PrivateObjectStorage } from "@certificate-platform/storage";

const MAX_STORAGE_KEY_BYTES = 2_048;

export interface PublicCertificateDownloadRepository {
  findByPublicIdentifier(publicIdentifier: string): Promise<PublicCertificateDownloadRecord | null>;
}

export interface PublicCertificateDownloadServiceOptions {
  readonly verificationKeys: ReadonlyMap<string, Uint8Array>;
  readonly repository: PublicCertificateDownloadRepository;
  readonly storage: Pick<PrivateObjectStorage, "get">;
  readonly maximumPdfBytes: number;
  readonly now?: () => Date;
}

export class PublicCertificateDownloadFailureError extends Error {
  constructor() {
    super("Public certificate download failed");
    this.name = "PublicCertificateDownloadFailureError";
  }
}

interface ValidPublication {
  readonly storageKey: string;
  readonly contentSha256: Uint8Array;
  readonly sizeBytes: number;
  readonly mimeType: "application/pdf";
  readonly generationRevision: number;
}

const validatePublication = (
  record: PublicCertificateDownloadRecord | null,
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
  && first.contentSha256.byteLength === second.contentSha256.byteLength
  && timingSafeEqual(Buffer.from(first.contentSha256), Buffer.from(second.contentSha256));

export class PublicCertificateDownloadService {
  readonly #options: PublicCertificateDownloadServiceOptions;

  constructor(options: PublicCertificateDownloadServiceOptions) {
    if (!Number.isSafeInteger(options.maximumPdfBytes) || options.maximumPdfBytes < 1) {
      throw new Error("Public certificate download size limit is invalid");
    }
    this.#options = options;
  }

  async download(downloadToken: string): Promise<Uint8Array> {
    try {
      const now = this.#options.now?.() ?? new Date();
      const publicIdentifier = verifyCertificateDownloadTokenForRedemption(
        downloadToken,
        this.#options.verificationKeys,
        now
      ).publicIdentifier;
      const publication = validatePublication(
        await this.#options.repository.findByPublicIdentifier(publicIdentifier),
        this.#options.maximumPdfBytes
      );
      if (publication === null) throw new PublicCertificateDownloadFailureError();

      const bytes = await this.#options.storage.get(publication.storageKey, this.#options.maximumPdfBytes);
      if (bytes.byteLength !== publication.sizeBytes
        || Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-") {
        throw new PublicCertificateDownloadFailureError();
      }
      const actualHash = createHash("sha256").update(bytes).digest();
      if (!timingSafeEqual(actualHash, Buffer.from(publication.contentSha256))) {
        throw new PublicCertificateDownloadFailureError();
      }

      const finalPublication = validatePublication(
        await this.#options.repository.findByPublicIdentifier(publicIdentifier),
        this.#options.maximumPdfBytes
      );
      if (finalPublication === null || !publicationMatches(publication, finalPublication)) {
        throw new PublicCertificateDownloadFailureError();
      }
      return new Uint8Array(bytes);
    } catch {
      throw new PublicCertificateDownloadFailureError();
    }
  }
}
