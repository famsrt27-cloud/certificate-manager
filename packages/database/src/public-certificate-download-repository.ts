import type { CertificateStatus } from "./types.js";
import type { DatabaseClient } from "./database.js";

export interface PublicCertificateDownloadRecord {
  readonly status: CertificateStatus;
  readonly pdfStorageKey: string | null;
  readonly pdfContentSha256: Uint8Array | null;
  readonly pdfSizeBytes: string | null;
  readonly pdfMimeType: string | null;
  readonly generationRevision: number;
}

export const findPublicCertificateDownload = async (
  database: DatabaseClient,
  publicIdentifier: string
): Promise<PublicCertificateDownloadRecord | null> => {
  const record = await database.selectFrom("certificates as certificate")
    .select([
      "certificate.status as status",
      "certificate.pdf_storage_key as pdfStorageKey",
      "certificate.pdf_content_sha256 as pdfContentSha256",
      "certificate.pdf_size_bytes as pdfSizeBytes",
      "certificate.pdf_mime_type as pdfMimeType",
      "certificate.generation_revision as generationRevision"
    ])
    .where("certificate.public_identifier", "=", publicIdentifier)
    .executeTakeFirst();
  return record ?? null;
};
