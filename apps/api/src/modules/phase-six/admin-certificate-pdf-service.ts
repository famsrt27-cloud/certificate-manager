import type { AdminCertificatePdfRecord } from "@certificate-platform/database";
import type { PrivateObjectStorage } from "@certificate-platform/storage";

import { ApplicationError } from "../../errors/application-error.js";
import { readPrivatePdfPublication } from "./private-pdf-publication-reader.js";

export interface AdminCertificatePdfRepository {
  findByOrganizationAndId(organizationId: string, certificateId: string): Promise<AdminCertificatePdfRecord | null>;
}

export interface AdminCertificatePdfServiceOptions {
  readonly repository: AdminCertificatePdfRepository;
  readonly storage: Pick<PrivateObjectStorage, "get">;
  readonly maximumPdfBytes: number;
}

const safeFilename = (certificateNumber: string): string => {
  const safeNumber = certificateNumber.normalize("NFKC").replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 120);
  return `certificate-${safeNumber.length > 0 ? safeNumber : "document"}.pdf`;
};

export class AdminCertificatePdfService {
  constructor(private readonly options: AdminCertificatePdfServiceOptions) {}

  async read(organizationId: string, certificateId: string): Promise<{
    readonly bytes: Uint8Array;
    readonly filename: string;
  }> {
    try {
      const publication = await readPrivatePdfPublication({
        loadPublication: () => this.options.repository.findByOrganizationAndId(organizationId, certificateId),
        storage: this.options.storage,
        maximumPdfBytes: this.options.maximumPdfBytes
      });
      return { bytes: publication.bytes, filename: safeFilename(publication.record.certificateNumber) };
    } catch {
      throw new ApplicationError("NOT_FOUND", "The requested resource was not found.", 404);
    }
  }
}
