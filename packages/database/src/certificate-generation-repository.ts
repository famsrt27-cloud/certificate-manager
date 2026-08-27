import { randomUUID } from "node:crypto";

import type { Kysely, Transaction } from "kysely";

import { CERTIFICATE_GENERATION_MAX_PARTICIPANTS, canonicalizeGenerationParticipantIds,
  createCertificateGenerationRequestFingerprint, type CertificateGenerationSelectionMode } from "@certificate-platform/domain";

import { insertAuditRecord, type NewAuditRecord } from "./authentication-repository.js";
import type { Database } from "./types.js";

export interface PlanCertificateGenerationInput {
  readonly organizationId: string;
  readonly trainingId: string;
  readonly templateVersionId: string;
  readonly idempotencyKey: string;
  readonly requestedByMembershipId: string;
  readonly selectionMode: CertificateGenerationSelectionMode;
  readonly requestedParticipantIds?: readonly string[];
  readonly rendererRevision: string;
  readonly verificationKeyKid: string;
  readonly plannedIssuedAt: Date;
  readonly auditRecord?: Omit<NewAuditRecord, "resourceId" | "metadata">;
}

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "23505";

export const findCertificateGenerationByIdempotency = (transaction: Transaction<Database>, organizationId: string, idempotencyKey: string) =>
  transaction.selectFrom("jobs as job").innerJoin("certificate_generation_jobs as detail", (join) => join
    .onRef("detail.job_id", "=", "job.id").onRef("detail.organization_id", "=", "job.organization_id"))
    .select(["job.id", "job.status", "detail.training_id", "detail.template_version_id", "detail.selection_mode", "detail.request_fingerprint"])
    .where("job.organization_id", "=", organizationId).where("job.job_type", "=", "CERTIFICATE_GENERATION")
    .where("job.idempotency_key", "=", idempotencyKey).executeTakeFirst();

export const planCertificateGenerationInTransaction = async (transaction: Transaction<Database>, input: PlanCertificateGenerationInput) => {
  const existing = await findCertificateGenerationByIdempotency(transaction, input.organizationId, input.idempotencyKey);
  if (existing !== undefined) {
    if (existing.training_id !== input.trainingId || existing.template_version_id !== input.templateVersionId
      || existing.selection_mode !== input.selectionMode) return { kind: "IDEMPOTENCY_CONFLICT" as const };
    if (input.selectionMode === "ALL_ELIGIBLE") return { kind: "EXISTING" as const, jobId: existing.id, status: existing.status, existing };
    const participantIds = canonicalizeGenerationParticipantIds(input.requestedParticipantIds ?? []);
    const fingerprint = createCertificateGenerationRequestFingerprint({ organizationId: input.organizationId, trainingId: input.trainingId,
      templateVersionId: input.templateVersionId, selectionMode: input.selectionMode, resolvedParticipantIds: participantIds });
    if (!Buffer.from(fingerprint).equals(Buffer.from(existing.request_fingerprint))) return { kind: "IDEMPOTENCY_CONFLICT" as const };
    return { kind: "EXISTING" as const, jobId: existing.id, status: existing.status, existing };
  }
  const training = await transaction.selectFrom("trainings as training").innerJoin("projects as project", (join) => join
    .onRef("project.id", "=", "training.project_id").onRef("project.organization_id", "=", "training.organization_id"))
    .select(["training.id", "training.name as training_name", "training.code", "project.name as project_name"])
    .where("training.organization_id", "=", input.organizationId).where("training.id", "=", input.trainingId)
    .where("training.status", "=", "ACTIVE").forUpdate().executeTakeFirst();
  if (training === undefined) return { kind: "NOT_FOUND" as const };
  const template = await transaction.selectFrom("template_versions").select("id").where("organization_id", "=", input.organizationId)
    .where("id", "=", input.templateVersionId).where("status", "=", "PUBLISHED").forUpdate().executeTakeFirst();
  if (template === undefined) return { kind: "TEMPLATE_INVALID" as const };
  let participantIds: readonly string[];
  if (input.selectionMode === "EXPLICIT") {
    participantIds = canonicalizeGenerationParticipantIds(input.requestedParticipantIds ?? []);
    if (participantIds.length > CERTIFICATE_GENERATION_MAX_PARTICIPANTS) return { kind: "SELECTION_TOO_LARGE" as const };
    const eligible = await transaction.selectFrom("training_participants as relation").innerJoin("participants as participant", (join) => join
      .onRef("participant.id", "=", "relation.participant_id").onRef("participant.organization_id", "=", "relation.organization_id"))
      .select("participant.id").where("relation.organization_id", "=", input.organizationId).where("relation.training_id", "=", input.trainingId)
      .where("relation.status", "=", "ACTIVE").where("participant.id", "in", participantIds)
      .where("participant.id", "not in", transaction.selectFrom("certificates").select("participant_id")
        .where("organization_id", "=", input.organizationId).where("training_id", "=", input.trainingId)).execute();
    if (eligible.length !== participantIds.length) return { kind: "INELIGIBLE" as const };
  } else {
    const resolved = await transaction.selectFrom("training_participants as relation").select("relation.participant_id")
      .where("relation.organization_id", "=", input.organizationId).where("relation.training_id", "=", input.trainingId).where("relation.status", "=", "ACTIVE")
      .where("relation.participant_id", "not in", transaction.selectFrom("certificates").select("participant_id")
        .where("organization_id", "=", input.organizationId).where("training_id", "=", input.trainingId))
      .limit(CERTIFICATE_GENERATION_MAX_PARTICIPANTS + 1).execute();
    if (resolved.length === 0) return { kind: "NO_WORK" as const };
    if (resolved.length > CERTIFICATE_GENERATION_MAX_PARTICIPANTS) return { kind: "SELECTION_TOO_LARGE" as const };
    participantIds = canonicalizeGenerationParticipantIds(resolved.map((row) => row.participant_id));
  }
  const recipients = await transaction.selectFrom("participants").select(["id", "display_name"]).where("organization_id", "=", input.organizationId).where("id", "in", participantIds).execute();
  const recipientById = new Map(recipients.map((recipient) => [recipient.id, recipient.display_name]));
  const jobId = randomUUID();
  const fingerprint = createCertificateGenerationRequestFingerprint({ organizationId: input.organizationId, trainingId: input.trainingId, templateVersionId: input.templateVersionId, selectionMode: input.selectionMode, resolvedParticipantIds: participantIds });
  await transaction.insertInto("jobs").values({ id: jobId, organization_id: input.organizationId, job_type: "CERTIFICATE_GENERATION", idempotency_key: input.idempotencyKey, requested_by_membership_id: input.requestedByMembershipId, progress_total: participantIds.length }).execute();
  await transaction.insertInto("certificate_generation_jobs").values({ job_id: jobId, organization_id: input.organizationId, training_id: input.trainingId, template_version_id: input.templateVersionId, selection_mode: input.selectionMode, request_fingerprint: fingerprint, renderer_revision: input.rendererRevision }).execute();
  for (const participantId of participantIds) {
    const certificate = await transaction.insertInto("certificates").values({ organization_id: input.organizationId, training_id: input.trainingId, participant_id: participantId, template_version_id: input.templateVersionId, certificate_number: `CERT-${randomUUID()}`, verification_key_kid: input.verificationKeyKid }).returning(["id", "generation_revision"]).executeTakeFirstOrThrow();
    await transaction.insertInto("certificate_issuance_snapshots").values({ certificate_id: certificate.id, organization_id: input.organizationId, recipient_display_name: recipientById.get(participantId)!, project_name: training.project_name, training_name: training.training_name, training_code: training.code, issued_at: input.plannedIssuedAt }).execute();
    await transaction.insertInto("certificate_generation_items").values({ organization_id: input.organizationId, job_id: jobId, certificate_id: certificate.id, generation_revision: certificate.generation_revision }).execute();
  }
  await transaction.insertInto("queue_outbox").values({ organization_id: input.organizationId, message_type: "CERTIFICATE_GENERATION", deduplication_key: `${jobId}-generate`, payload_json: { version: 1, job_id: jobId, organization_id: input.organizationId } }).execute();
  if (input.auditRecord !== undefined) {
    await insertAuditRecord(transaction, {
      ...input.auditRecord,
      resourceId: jobId,
      metadata: { training_id: input.trainingId, template_version_id: input.templateVersionId,
        selection_mode: input.selectionMode, participant_count: participantIds.length }
    });
  }
  return { kind: "CREATED" as const, jobId, status: "QUEUED" as const, fingerprint };
};

export const planCertificateGeneration = async (database: Kysely<Database>, input: PlanCertificateGenerationInput) => {
  let outcome;
  try {
    outcome = await database.transaction().execute((transaction) => planCertificateGenerationInTransaction(transaction, input));
    if (outcome.kind !== "INELIGIBLE" && outcome.kind !== "NO_WORK") return outcome;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    outcome = { kind: "INELIGIBLE" as const };
  }
  const existing = await database.transaction().execute((transaction) =>
    findCertificateGenerationByIdempotency(transaction, input.organizationId, input.idempotencyKey));
  if (existing === undefined) return outcome;
    if (existing.training_id !== input.trainingId || existing.template_version_id !== input.templateVersionId
      || existing.selection_mode !== input.selectionMode) return { kind: "IDEMPOTENCY_CONFLICT" as const };
    if (input.selectionMode === "EXPLICIT") {
      const fingerprint = createCertificateGenerationRequestFingerprint({ organizationId: input.organizationId,
        trainingId: input.trainingId, templateVersionId: input.templateVersionId, selectionMode: input.selectionMode,
        resolvedParticipantIds: canonicalizeGenerationParticipantIds(input.requestedParticipantIds ?? []) });
      if (!Buffer.from(fingerprint).equals(Buffer.from(existing.request_fingerprint))) {
        return { kind: "IDEMPOTENCY_CONFLICT" as const };
      }
    }
    return { kind: "EXISTING" as const, jobId: existing.id, status: existing.status, existing };
};
