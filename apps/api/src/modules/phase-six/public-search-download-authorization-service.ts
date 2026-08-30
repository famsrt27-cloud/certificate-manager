import type { PublicDownloadAuthorizationData } from "@certificate-platform/contracts";
import type { PublicCertificateDownloadAuthorizationRecord } from "@certificate-platform/database";
import { createCertificateDownloadToken, verifyCertificateSearchResultToken } from "@certificate-platform/domain";

const MAX_STORAGE_KEY_BYTES = 2_048;

export interface PublicSearchDownloadAuthorizationRepository {
  findByPublicIdentifier(publicIdentifier: string): Promise<PublicCertificateDownloadAuthorizationRecord | null>;
}

export interface PublicSearchDownloadAuthorizationServiceOptions {
  readonly verificationKeys: ReadonlyMap<string, Uint8Array>;
  readonly activeSigningKeyId: string;
  readonly activeSigningKey: Uint8Array;
  readonly repository: PublicSearchDownloadAuthorizationRepository;
  readonly downloadTtlSeconds: number;
  readonly now?: () => Date;
}

export class PublicSearchDownloadAuthorizationFailureError extends Error {
  constructor() {
    super("Public search download authorization failed");
    this.name = "PublicSearchDownloadAuthorizationFailureError";
  }
}

const hasValidPublicationMetadata = (record: PublicCertificateDownloadAuthorizationRecord): boolean => {
  if (record.status !== "AVAILABLE" || record.pdfStorageKey === null || record.pdfContentSha256 === null
    || record.pdfSizeBytes === null || record.pdfMimeType !== "application/pdf") return false;
  if (Buffer.byteLength(record.pdfStorageKey, "utf8") < 1
    || Buffer.byteLength(record.pdfStorageKey, "utf8") > MAX_STORAGE_KEY_BYTES
    || record.pdfContentSha256.byteLength !== 32) return false;
  try {
    const size = BigInt(record.pdfSizeBytes);
    return size > 0n && size <= BigInt(Number.MAX_SAFE_INTEGER) && size.toString() === record.pdfSizeBytes;
  } catch { return false; }
};

export class PublicSearchDownloadAuthorizationService {
  readonly #options: PublicSearchDownloadAuthorizationServiceOptions;
  constructor(options: PublicSearchDownloadAuthorizationServiceOptions) { this.#options = options; }

  async authorize(searchResultToken: string): Promise<PublicDownloadAuthorizationData> {
    try {
      const now = this.#options.now?.() ?? new Date();
      const publicIdentifier = verifyCertificateSearchResultToken(
        searchResultToken, this.#options.verificationKeys, now
      ).publicIdentifier;
      const certificate = await this.#options.repository.findByPublicIdentifier(publicIdentifier);
      if (certificate === null || !hasValidPublicationMetadata(certificate)) {
        throw new PublicSearchDownloadAuthorizationFailureError();
      }
      return {
        download_token: createCertificateDownloadToken({ keyId: this.#options.activeSigningKeyId,
          key: this.#options.activeSigningKey, publicIdentifier, issuedAt: now,
          ttlSeconds: this.#options.downloadTtlSeconds }),
        expires_in: this.#options.downloadTtlSeconds
      };
    } catch {
      throw new PublicSearchDownloadAuthorizationFailureError();
    }
  }
}
