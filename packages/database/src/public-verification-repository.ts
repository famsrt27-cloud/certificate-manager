import type { CertificateStatus } from "./types.js";
import type { DatabaseClient } from "./database.js";

export interface PublicCertificateVerificationRecord {
  readonly status: CertificateStatus;
  readonly certificateNumber: string;
  readonly recipientName: string;
  readonly programName: string;
  readonly issuedAt: Date;
}

export const findPublicCertificateVerification = async (
  database: DatabaseClient,
  publicIdentifier: string
): Promise<PublicCertificateVerificationRecord | null> => {
  const record = await database.selectFrom("certificates as certificate")
    .innerJoin("certificate_issuance_snapshots as snapshot", "snapshot.certificate_id", "certificate.id")
    .select([
      "certificate.status as status",
      "certificate.certificate_number as certificateNumber",
      "snapshot.recipient_display_name as recipientName",
      "snapshot.project_name as programName",
      "snapshot.issued_at as issuedAt"
    ])
    .where("certificate.public_identifier", "=", publicIdentifier)
    .executeTakeFirst();
  return record ?? null;
};
