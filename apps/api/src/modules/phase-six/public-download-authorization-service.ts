import type { PublicDownloadAuthorizationData } from "@certificate-platform/contracts";
import type { PublicCertificateDownloadAuthorizationRecord } from "@certificate-platform/database";
import { createCertificateDownloadToken, verifyCertificateVerificationToken } from "@certificate-platform/domain";

const MAX_STORAGE_KEY_BYTES = 2_048;

export interface PublicDownloadAuthorizationRepository {
  findByPublicIdentifier(publicIdentifier: string): Promise<PublicCertificateDownloadAuthorizationRecord | null>;
}

export interface PublicDownloadAuthorizationServiceOptions {
  readonly verificationKeys: ReadonlyMap<string, Uint8Array>;
  readonly activeSigningKeyId: string;
  readonly activeSigningKey: Uint8Array;
  readonly repository: PublicDownloadAuthorizationRepository;
  readonly ttlSeconds: number;
  readonly now?: () => Date;
}

export class PublicDownloadAuthorizationFailureError extends Error {
  constructor() {
    super("Public certificate download authorization failed");
    this.name = "PublicDownloadAuthorizationFailureError";
  }
}

const hasValidPublicationMetadata = (record: PublicCertificateDownloadAuthorizationRecord): boolean => {
  if (record.status !== "AVAILABLE" || record.pdfStorageKey === null || record.pdfContentSha256 === null
    || record.pdfSizeBytes === null || record.pdfMimeType !== "application/pdf") return false;
  const storageKeyBytes = Buffer.byteLength(record.pdfStorageKey, "utf8");
  if (storageKeyBytes < 1 || storageKeyBytes > MAX_STORAGE_KEY_BYTES || record.pdfContentSha256.byteLength !== 32) return false;
  let size: bigint;
  try {
    size = BigInt(record.pdfSizeBytes);
  } catch {
    return false;
  }
  return size > 0n && size <= BigInt(Number.MAX_SAFE_INTEGER) && size.toString() === record.pdfSizeBytes;
};

export class PublicDownloadAuthorizationService {
  readonly #options: PublicDownloadAuthorizationServiceOptions;

  constructor(options: PublicDownloadAuthorizationServiceOptions) {
    this.#options = options;
  }

  async authorize(token: string): Promise<PublicDownloadAuthorizationData> {
    let publicIdentifier: string;
    try {
      publicIdentifier = verifyCertificateVerificationToken(token, this.#options.verificationKeys).publicIdentifier;
    } catch {
      throw new PublicDownloadAuthorizationFailureError();
    }
    const certificate = await this.#options.repository.findByPublicIdentifier(publicIdentifier);
    if (certificate === null || !hasValidPublicationMetadata(certificate)) {
      throw new PublicDownloadAuthorizationFailureError();
    }
    try {
      const issuedAt = this.#options.now?.() ?? new Date();
      return {
        download_token: createCertificateDownloadToken({ keyId: this.#options.activeSigningKeyId,
          key: this.#options.activeSigningKey, publicIdentifier, issuedAt, ttlSeconds: this.#options.ttlSeconds }),
        expires_in: this.#options.ttlSeconds
      };
    } catch {
      throw new PublicDownloadAuthorizationFailureError();
    }
  }
}
