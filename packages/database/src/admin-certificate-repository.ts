import type { Kysely, Transaction } from "kysely";

import type { CertificateStatus, Database } from "./types.js";
import type { ResourceCursor } from "./phase-three-repository.js";

export interface AdminCertificateListInput {
  readonly organizationId: string;
  readonly limit: number;
  readonly cursor?: ResourceCursor;
  readonly trainingId?: string;
  readonly status?: CertificateStatus;
}

export interface AdminCertificatePdfRecord {
  readonly certificateNumber: string;
  readonly status: CertificateStatus;
  readonly pdfStorageKey: string | null;
  readonly pdfContentSha256: Uint8Array | null;
  readonly pdfSizeBytes: string | null;
  readonly pdfMimeType: string | null;
  readonly generationRevision: number;
}

export const findAdminCertificatePdf = async (
  database: Kysely<Database>,
  organizationId: string,
  certificateId: string
): Promise<AdminCertificatePdfRecord | null> => {
  const record = await database.selectFrom("certificates as certificate")
    .select([
      "certificate.certificate_number as certificateNumber",
      "certificate.status as status",
      "certificate.pdf_storage_key as pdfStorageKey",
      "certificate.pdf_content_sha256 as pdfContentSha256",
      "certificate.pdf_size_bytes as pdfSizeBytes",
      "certificate.pdf_mime_type as pdfMimeType",
      "certificate.generation_revision as generationRevision"
    ])
    .where("certificate.organization_id", "=", organizationId)
    .where("certificate.id", "=", certificateId)
    .executeTakeFirst();
  return record ?? null;
};

const certificateSelection = [
  "certificate.id", "certificate.certificate_number", "certificate.status", "certificate.training_id",
  "certificate.issued_at", "certificate.revoked_at", "certificate.revocation_reason", "certificate.created_at",
  "snapshot.recipient_display_name", "snapshot.project_name", "snapshot.training_name", "snapshot.training_code"
] as const;

export const listAdminCertificates = async (database: Kysely<Database>, input: AdminCertificateListInput) => {
  let query = database.selectFrom("certificates as certificate")
    .innerJoin("certificate_issuance_snapshots as snapshot", (join) => join
      .onRef("snapshot.certificate_id", "=", "certificate.id")
      .onRef("snapshot.organization_id", "=", "certificate.organization_id"))
    .select(certificateSelection)
    .where("certificate.organization_id", "=", input.organizationId);
  if (input.trainingId !== undefined) query = query.where("certificate.training_id", "=", input.trainingId);
  if (input.status !== undefined) query = query.where("certificate.status", "=", input.status);
  if (input.cursor !== undefined) query = query.where((expression) => expression.or([
    expression("certificate.created_at", "<", input.cursor!.createdAt),
    expression.and([expression("certificate.created_at", "=", input.cursor!.createdAt), expression("certificate.id", "<", input.cursor!.id)])
  ]));
  return query.orderBy("certificate.created_at", "desc").orderBy("certificate.id", "desc").limit(input.limit + 1).execute();
};

export type RevokeCertificateOutcome =
  | { readonly kind: "REVOKED" | "EXISTING"; readonly certificate: Awaited<ReturnType<typeof listAdminCertificates>>[number] }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "CONFLICT" };

export const revokeAdminCertificateInTransaction = async (
  transaction: Transaction<Database>, input: { readonly organizationId: string; readonly certificateId: string; readonly reason: string; readonly revokedAt: Date }
): Promise<RevokeCertificateOutcome> => {
  const current = await transaction.selectFrom("certificates").select(["status", "revocation_reason"])
    .where("organization_id", "=", input.organizationId).where("id", "=", input.certificateId).forUpdate().executeTakeFirst();
  if (current === undefined) return { kind: "NOT_FOUND" };
  if (current.status !== "AVAILABLE" && current.status !== "REVOKED") return { kind: "CONFLICT" };
  const kind = current.status === "REVOKED" ? "EXISTING" : "REVOKED";
  if (kind === "REVOKED") {
    await transaction.updateTable("certificates").set({ status: "REVOKED", revoked_at: input.revokedAt,
      revocation_reason: input.reason, updated_at: input.revokedAt })
      .where("organization_id", "=", input.organizationId).where("id", "=", input.certificateId)
      .where("status", "=", "AVAILABLE").executeTakeFirstOrThrow();
  }
  const certificate = await transaction.selectFrom("certificates as certificate")
    .innerJoin("certificate_issuance_snapshots as snapshot", (join) => join
      .onRef("snapshot.certificate_id", "=", "certificate.id")
      .onRef("snapshot.organization_id", "=", "certificate.organization_id"))
    .select(certificateSelection).where("certificate.organization_id", "=", input.organizationId)
    .where("certificate.id", "=", input.certificateId).executeTakeFirstOrThrow();
  return { kind, certificate };
};
