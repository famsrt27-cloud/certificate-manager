import type { PublicCertificateDownloadRecord } from "@certificate-platform/database";
import { verifyCertificateDownloadTokenForRedemption } from "@certificate-platform/domain";
import type { PrivateObjectStorage } from "@certificate-platform/storage";
import { readPrivatePdfPublication } from "./private-pdf-publication-reader.js";

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
      return (await readPrivatePdfPublication({
        loadPublication: () => this.#options.repository.findByPublicIdentifier(publicIdentifier),
        storage: this.#options.storage,
        maximumPdfBytes: this.#options.maximumPdfBytes
      })).bytes;
    } catch {
      throw new PublicCertificateDownloadFailureError();
    }
  }
}
