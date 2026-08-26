import type { PublicVerificationData } from "@certificate-platform/contracts";
import type { PublicCertificateVerificationRecord } from "@certificate-platform/database";
import { verifyCertificateVerificationToken } from "@certificate-platform/domain";

export interface PublicVerificationRepository {
  findByPublicIdentifier(publicIdentifier: string): Promise<PublicCertificateVerificationRecord | null>;
}

export interface PublicVerificationServiceOptions {
  readonly verificationKeys: ReadonlyMap<string, Uint8Array>;
  readonly repository: PublicVerificationRepository;
  readonly maximumTokenBytes?: number;
}

export class PublicVerificationFailureError extends Error {
  constructor() {
    super("Public certificate verification failed");
    this.name = "PublicVerificationFailureError";
  }
}

export class PublicVerificationService {
  readonly #verificationKeys: ReadonlyMap<string, Uint8Array>;
  readonly #repository: PublicVerificationRepository;
  readonly #maximumTokenBytes: number | undefined;

  constructor(options: PublicVerificationServiceOptions) {
    this.#verificationKeys = options.verificationKeys;
    this.#repository = options.repository;
    this.#maximumTokenBytes = options.maximumTokenBytes;
  }

  async verify(token: string): Promise<PublicVerificationData> {
    let publicIdentifier: string;
    try {
      publicIdentifier = verifyCertificateVerificationToken(
        token,
        this.#verificationKeys,
        this.#maximumTokenBytes
      ).publicIdentifier;
    } catch {
      throw new PublicVerificationFailureError();
    }

    const certificate = await this.#repository.findByPublicIdentifier(publicIdentifier);
    if (certificate === null) throw new PublicVerificationFailureError();
    if (certificate.status === "REVOKED") {
      return { status: "revoked", certificate_number: certificate.certificateNumber };
    }
    if (certificate.status !== "AVAILABLE") throw new PublicVerificationFailureError();
    return {
      status: "valid",
      certificate_number: certificate.certificateNumber,
      recipient_name: certificate.recipientName,
      program_name: certificate.programName,
      issued_at: certificate.issuedAt.toISOString().slice(0, 10)
    };
  }
}
