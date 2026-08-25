import type { Kysely } from "kysely";
import { sql } from "kysely";

import { cancelStorageCleanupInTransaction } from "./storage-cleanup-repository.js";
import type { Database, JsonValue } from "./types.js";

export const CERTIFICATE_GENERATION_ERROR_CODES = {
  invalidJob: "CERTIFICATE_GENERATION_JOB_INVALID",
  unsupportedRenderer: "CERTIFICATE_RENDERER_UNSUPPORTED",
  staleRevision: "CERTIFICATE_GENERATION_STALE_REVISION",
  processingFailed: "CERTIFICATE_GENERATION_FAILED"
} as const;

export class CertificateGenerationExecutionError extends Error {
  constructor(readonly code: (typeof CERTIFICATE_GENERATION_ERROR_CODES)[keyof typeof CERTIFICATE_GENERATION_ERROR_CODES]) {
    super(code);
    this.name = "CertificateGenerationExecutionError";
  }
}

export interface CertificateGenerationAssetRecord {
  readonly id: string;
  readonly storageKey: string;
  readonly contentSha256: Uint8Array;
  readonly detectedMimeType: string;
  readonly sizeBytes: number;
  readonly status: "QUARANTINED" | "ACTIVE" | "REJECTED" | "ARCHIVED";
}

export interface ClaimedCertificateGenerationItem {
  readonly itemId: string;
  readonly jobId: string;
  readonly organizationId: string;
  readonly certificateId: string;
  readonly generationRevision: number;
  readonly rendererRevision: string;
  readonly publicIdentifier: string;
  readonly certificateNumber: string;
  readonly verificationKeyKid: string;
  readonly plannedIssuedAt: Date;
  readonly recipientDisplayName: string;
  readonly projectName: string;
  readonly trainingName: string;
  readonly trainingCode: string;
  readonly templateDefinition: JsonValue;
  readonly assets: readonly CertificateGenerationAssetRecord[];
}

export type BeginCertificateGenerationResult = "READY" | "COMPLETE" | "TERMINAL";

export const beginCertificateGenerationJob = async (
  database: Kysely<Database>,
  input: { readonly organizationId: string; readonly jobId: string; readonly supportedRendererRevision: string }
): Promise<BeginCertificateGenerationResult> => database.transaction().execute(async (transaction) => {
  const job = await transaction.selectFrom("jobs as job")
    .innerJoin("certificate_generation_jobs as detail", (join) => join
      .onRef("detail.job_id", "=", "job.id")
      .onRef("detail.organization_id", "=", "job.organization_id"))
    .select(["job.status", "detail.renderer_revision"])
    .where("job.organization_id", "=", input.organizationId)
    .where("job.id", "=", input.jobId)
    .where("job.job_type", "=", "CERTIFICATE_GENERATION")
    .forUpdate()
    .executeTakeFirst();
  if (job === undefined) throw new CertificateGenerationExecutionError(CERTIFICATE_GENERATION_ERROR_CODES.invalidJob);
  if (job.renderer_revision !== input.supportedRendererRevision) {
    throw new CertificateGenerationExecutionError(CERTIFICATE_GENERATION_ERROR_CODES.unsupportedRenderer);
  }
  if (job.status === "SUCCEEDED") return "COMPLETE";
  if (job.status === "DEAD_LETTER" || job.status === "CANCELLED") return "TERMINAL";
  const now = new Date();
  await transaction.updateTable("jobs").set({
    status: "RUNNING",
    attempt_count: sql<number>`least(attempt_count + 1, max_attempts)`,
    started_at: sql<Date>`coalesce(started_at, ${now})`,
    completed_at: null,
    last_error_code: null,
    updated_at: now
  }).where("organization_id", "=", input.organizationId).where("id", "=", input.jobId).execute();
  return "READY";
});

export type ClaimCertificateGenerationItemResult =
  | { readonly kind: "CLAIMED"; readonly item: ClaimedCertificateGenerationItem }
  | { readonly kind: "COMPLETE" }
  | { readonly kind: "BUSY" };

export const claimCertificateGenerationItem = async (
  database: Kysely<Database>,
  input: { readonly organizationId: string; readonly jobId: string; readonly staleBefore: Date }
): Promise<ClaimCertificateGenerationItemResult> => database.transaction().execute(async (transaction) => {
  const detail = await transaction.selectFrom("certificate_generation_jobs as detail")
    .innerJoin("jobs as job", (join) => join.onRef("job.id", "=", "detail.job_id")
      .onRef("job.organization_id", "=", "detail.organization_id"))
    .select(["detail.template_version_id", "detail.generation_revision", "detail.renderer_revision", "job.status"])
    .where("detail.organization_id", "=", input.organizationId).where("detail.job_id", "=", input.jobId)
    .where("job.job_type", "=", "CERTIFICATE_GENERATION").executeTakeFirst();
  if (detail === undefined) throw new CertificateGenerationExecutionError(CERTIFICATE_GENERATION_ERROR_CODES.invalidJob);
  if (detail.status === "SUCCEEDED") return { kind: "COMPLETE" };

  const item = await transaction.selectFrom("certificate_generation_items")
    .select(["id", "certificate_id", "generation_revision"])
    .where("organization_id", "=", input.organizationId).where("job_id", "=", input.jobId)
    .where((expression) => expression.or([
      expression("status", "in", ["PENDING", "FAILED"]),
      expression.and([expression("status", "=", "RUNNING"), expression("updated_at", "<=", input.staleBefore)])
    ]))
    .orderBy("created_at", "asc").orderBy("id", "asc").limit(1).forUpdate().skipLocked().executeTakeFirst();

  if (item === undefined) {
    const remaining = await transaction.selectFrom("certificate_generation_items")
      .select(sql<number>`count(*) filter (where status <> 'SUCCEEDED')::int`.as("count"))
      .where("organization_id", "=", input.organizationId).where("job_id", "=", input.jobId).executeTakeFirstOrThrow();
    return remaining.count === 0 ? { kind: "COMPLETE" } : { kind: "BUSY" };
  }

  const certificate = await transaction.selectFrom("certificates")
    .select(["id", "status", "generation_revision", "template_version_id", "public_identifier", "certificate_number", "verification_key_kid"])
    .where("organization_id", "=", input.organizationId).where("id", "=", item.certificate_id).forUpdate().executeTakeFirst();
  if (certificate === undefined || certificate.template_version_id !== detail.template_version_id
    || item.generation_revision !== detail.generation_revision || certificate.generation_revision !== item.generation_revision
    || certificate.verification_key_kid === null || (certificate.status !== "DRAFT" && certificate.status !== "GENERATING")) {
    throw new CertificateGenerationExecutionError(CERTIFICATE_GENERATION_ERROR_CODES.staleRevision);
  }

  if (certificate.status === "DRAFT") {
    const transitioned = await transaction.updateTable("certificates").set({ status: "GENERATING", updated_at: new Date() })
      .where("organization_id", "=", input.organizationId).where("id", "=", certificate.id)
      .where("status", "=", "DRAFT").where("generation_revision", "=", item.generation_revision)
      .returning("id").executeTakeFirst();
    if (transitioned === undefined) throw new CertificateGenerationExecutionError(CERTIFICATE_GENERATION_ERROR_CODES.staleRevision);
  }

  await transaction.updateTable("certificate_generation_items").set({
    status: "RUNNING",
    attempt_count: sql<number>`attempt_count + 1`,
    last_error_code: null,
    updated_at: new Date()
  }).where("organization_id", "=", input.organizationId).where("id", "=", item.id).execute();

  const snapshot = await transaction.selectFrom("certificate_issuance_snapshots").select([
    "recipient_display_name", "project_name", "training_name", "training_code", "issued_at"
  ]).where("organization_id", "=", input.organizationId).where("certificate_id", "=", certificate.id).executeTakeFirst();
  const version = await transaction.selectFrom("template_versions").select(["definition_json", "template_id", "status"])
    .where("organization_id", "=", input.organizationId).where("id", "=", detail.template_version_id).executeTakeFirst();
  if (snapshot === undefined || version === undefined || (version.status !== "PUBLISHED" && version.status !== "ARCHIVED")) {
    throw new CertificateGenerationExecutionError(CERTIFICATE_GENERATION_ERROR_CODES.invalidJob);
  }
  const assets = await transaction.selectFrom("template_version_assets as link")
    .innerJoin("template_assets as asset", (join) => join.onRef("asset.id", "=", "link.asset_id")
      .onRef("asset.organization_id", "=", "link.organization_id").onRef("asset.template_id", "=", "link.template_id"))
    .select(["asset.id", "asset.storage_key", "asset.content_sha256", "asset.detected_mime_type", "asset.size_bytes", "asset.status"])
    .where("link.organization_id", "=", input.organizationId).where("link.template_version_id", "=", detail.template_version_id)
    .orderBy("asset.id", "asc").execute();

  return { kind: "CLAIMED", item: {
    itemId: item.id, jobId: input.jobId, organizationId: input.organizationId, certificateId: certificate.id,
    generationRevision: item.generation_revision, rendererRevision: detail.renderer_revision,
    publicIdentifier: certificate.public_identifier, certificateNumber: certificate.certificate_number,
    verificationKeyKid: certificate.verification_key_kid, plannedIssuedAt: snapshot.issued_at,
    recipientDisplayName: snapshot.recipient_display_name, projectName: snapshot.project_name,
    trainingName: snapshot.training_name, trainingCode: snapshot.training_code, templateDefinition: version.definition_json,
    assets: assets.map((asset) => ({ id: asset.id, storageKey: asset.storage_key, contentSha256: asset.content_sha256,
      detectedMimeType: asset.detected_mime_type, sizeBytes: Number(asset.size_bytes), status: asset.status }))
  } };
});

export interface PublishCertificateGenerationInput {
  readonly organizationId: string;
  readonly jobId: string;
  readonly itemId: string;
  readonly certificateId: string;
  readonly generationRevision: number;
  readonly objectKey: string;
  readonly contentSha256: Uint8Array;
  readonly sizeBytes: number;
  readonly mimeType: "application/pdf";
}

export const publishCertificateGeneration = async (
  database: Kysely<Database>, input: PublishCertificateGenerationInput
): Promise<"PUBLISHED" | "ALREADY_PUBLISHED"> => database.transaction().execute(async (transaction) => {
  if (input.contentSha256.byteLength !== 32 || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new CertificateGenerationExecutionError(CERTIFICATE_GENERATION_ERROR_CODES.invalidJob);
  }
  const item = await transaction.selectFrom("certificate_generation_items").select(["status", "certificate_id", "generation_revision"])
    .where("organization_id", "=", input.organizationId).where("job_id", "=", input.jobId).where("id", "=", input.itemId)
    .forUpdate().executeTakeFirst();
  const certificate = await transaction.selectFrom("certificates").select([
    "status", "generation_revision", "pdf_storage_key", "pdf_content_sha256", "pdf_size_bytes", "pdf_mime_type"
  ]).where("organization_id", "=", input.organizationId).where("id", "=", input.certificateId).forUpdate().executeTakeFirst();
  if (item === undefined || certificate === undefined || item.certificate_id !== input.certificateId
    || item.generation_revision !== input.generationRevision) {
    throw new CertificateGenerationExecutionError(CERTIFICATE_GENERATION_ERROR_CODES.staleRevision);
  }
  if (item.status === "SUCCEEDED" && certificate.status === "AVAILABLE"
    && certificate.generation_revision === input.generationRevision && certificate.pdf_storage_key === input.objectKey
    && certificate.pdf_size_bytes === String(input.sizeBytes) && certificate.pdf_mime_type === input.mimeType
    && certificate.pdf_content_sha256 !== null && Buffer.from(certificate.pdf_content_sha256).equals(Buffer.from(input.contentSha256))) {
    await cancelStorageCleanupInTransaction(transaction, input.organizationId, input.objectKey);
    return "ALREADY_PUBLISHED";
  }
  if (item.status !== "RUNNING" || certificate.status !== "GENERATING" || certificate.generation_revision !== input.generationRevision) {
    throw new CertificateGenerationExecutionError(CERTIFICATE_GENERATION_ERROR_CODES.staleRevision);
  }
  const snapshot = await transaction.selectFrom("certificate_issuance_snapshots").select("issued_at")
    .where("organization_id", "=", input.organizationId).where("certificate_id", "=", input.certificateId).executeTakeFirstOrThrow();
  await transaction.updateTable("certificate_generation_items").set({ status: "SUCCEEDED", last_error_code: null, updated_at: new Date() })
    .where("organization_id", "=", input.organizationId).where("id", "=", input.itemId).where("status", "=", "RUNNING").executeTakeFirstOrThrow();
  const published = await transaction.updateTable("certificates").set({
    status: "AVAILABLE", issued_at: snapshot.issued_at, pdf_storage_key: input.objectKey,
    pdf_content_sha256: input.contentSha256, pdf_size_bytes: String(input.sizeBytes), pdf_mime_type: input.mimeType,
    updated_at: new Date()
  }).where("organization_id", "=", input.organizationId).where("id", "=", input.certificateId)
    .where("status", "=", "GENERATING").where("generation_revision", "=", input.generationRevision)
    .returning("id").executeTakeFirst();
  if (published === undefined) throw new CertificateGenerationExecutionError(CERTIFICATE_GENERATION_ERROR_CODES.staleRevision);
  await cancelStorageCleanupInTransaction(transaction, input.organizationId, input.objectKey);
  const counts = await transaction.selectFrom("certificate_generation_items").select([
    sql<number>`count(*)::int`.as("total"), sql<number>`count(*) filter (where status = 'SUCCEEDED')::int`.as("completed")
  ]).where("organization_id", "=", input.organizationId).where("job_id", "=", input.jobId).executeTakeFirstOrThrow();
  const complete = counts.total === counts.completed;
  await transaction.updateTable("jobs").set({
    progress_completed: counts.completed,
    status: complete ? "SUCCEEDED" : "RUNNING",
    completed_at: complete ? new Date() : null,
    last_error_code: null,
    updated_at: new Date()
  }).where("organization_id", "=", input.organizationId).where("id", "=", input.jobId)
    .where("job_type", "=", "CERTIFICATE_GENERATION").execute();
  return "PUBLISHED";
});

export const markCertificateGenerationItemFailed = async (
  database: Kysely<Database>, input: { readonly organizationId: string; readonly jobId: string; readonly itemId: string; readonly errorCode: string }
): Promise<void> => {
  await database.transaction().execute(async (transaction) => {
    await transaction.updateTable("certificate_generation_items").set({ status: "FAILED", last_error_code: input.errorCode, updated_at: new Date() })
      .where("organization_id", "=", input.organizationId).where("job_id", "=", input.jobId)
      .where("id", "=", input.itemId).where("status", "=", "RUNNING").execute();
    await transaction.updateTable("jobs").set({ last_error_code: input.errorCode, updated_at: new Date() })
      .where("organization_id", "=", input.organizationId).where("id", "=", input.jobId)
      .where("status", "not in", ["SUCCEEDED", "DEAD_LETTER", "CANCELLED"]).execute();
  });
};

export const deadLetterCertificateGeneration = async (
  database: Kysely<Database>, organizationId: string, jobId: string, errorCode: string
): Promise<void> => {
  await database.transaction().execute(async (transaction) => {
    const job = await transaction.selectFrom("jobs").select("status").where("organization_id", "=", organizationId)
      .where("id", "=", jobId).where("job_type", "=", "CERTIFICATE_GENERATION").forUpdate().executeTakeFirst();
    if (job === undefined || job.status === "SUCCEEDED" || job.status === "CANCELLED") return;
    await transaction.updateTable("certificate_generation_items").set({ status: "DEAD_LETTER", last_error_code: errorCode, updated_at: new Date() })
      .where("organization_id", "=", organizationId).where("job_id", "=", jobId)
      .where("status", "not in", ["SUCCEEDED", "SKIPPED"]).execute();
    await transaction.updateTable("jobs").set({ status: "DEAD_LETTER", last_error_code: errorCode, completed_at: new Date(), updated_at: new Date() })
      .where("organization_id", "=", organizationId).where("id", "=", jobId).execute();
  });
};
