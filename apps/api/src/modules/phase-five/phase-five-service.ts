import type { AdminCertificate, GenerateCertificatesRequest, RevokeCertificateRequest } from "@certificate-platform/contracts";
import { listAdminCertificates, planCertificateGeneration, revokeAdminCertificateInTransaction, runAuditedTransaction,
  type DatabaseClient, type NewAuditRecord } from "@certificate-platform/database";
import { ApplicationError } from "../../errors/application-error.js";
import type { TenantAuthorizationContext } from "../auth/organization-authorization-service.js";
import { CursorCodec } from "../phase-three/cursor-codec.js";

const mapCertificate = (row: Awaited<ReturnType<typeof listAdminCertificates>>[number]): AdminCertificate => ({
  id: row.id, certificate_number: row.certificate_number, status: row.status,
  recipient_display_name: row.recipient_display_name, project_name: row.project_name,
  training_name: row.training_name, training_code: row.training_code, training_id: row.training_id,
  issued_at: row.issued_at?.toISOString() ?? null, revoked_at: row.revoked_at?.toISOString() ?? null,
  revocation_reason: row.revocation_reason
});

export class PhaseFiveService {
  readonly #cursors: CursorCodec;
  constructor(private readonly options: { database: DatabaseClient; verificationKeyKid: string; cursorSecret: string; now?: () => Date }) {
    this.#cursors = new CursorCodec(options.cursorSecret);
  }
  async generate(context: TenantAuthorizationContext, trainingId: string, idempotencyKey: string,
    requestId: string, request: GenerateCertificatesRequest) {
    if (context.actorMembershipId === null) throw new ApplicationError("FORBIDDEN", "The requested operation is not permitted.", 403);
    const selectionMode = request.participant_ids === undefined ? "ALL_ELIGIBLE" : "EXPLICIT";
    const outcome = await planCertificateGeneration(this.options.database, {
      organizationId: context.organizationId, trainingId, templateVersionId: request.template_version_id,
      idempotencyKey, requestedByMembershipId: context.actorMembershipId, selectionMode,
      ...(request.participant_ids === undefined ? {} : { requestedParticipantIds: request.participant_ids }),
      rendererRevision: "pdfkit-qrcode-v2", verificationKeyKid: this.options.verificationKeyKid,
      plannedIssuedAt: (this.options.now ?? (() => new Date()))(),
      auditRecord: { organizationId: context.organizationId, actorUserId: context.actorUserId,
        actorMembershipId: context.actorMembershipId, action: "CERTIFICATE_GENERATION_REQUESTED",
        resourceType: "certificate_generation", requestId }
    });
    if (outcome.kind === "NOT_FOUND") throw new ApplicationError("NOT_FOUND", "The requested resource was not found.", 404);
    if (outcome.kind === "TEMPLATE_INVALID") throw new ApplicationError("CONFLICT", "The requested operation conflicts with existing data.", 409);
    if (outcome.kind === "INELIGIBLE" || outcome.kind === "NO_WORK" || outcome.kind === "IDEMPOTENCY_CONFLICT"
      || outcome.kind === "SELECTION_TOO_LARGE") {
      throw new ApplicationError("CONFLICT", "The requested operation conflicts with existing data.", 409);
    }
    return { job_id: outcome.jobId, status: outcome.status };
  }

  async listCertificates(organizationId: string, input: { readonly limit: number; readonly cursor?: string | undefined;
    readonly training_id?: string | undefined; readonly status?: AdminCertificate["status"] | undefined }) {
    const cursor = input.cursor === undefined ? undefined : this.#cursors.decode(input.cursor, organizationId, "certificates");
    const rows = await listAdminCertificates(this.options.database, { organizationId, limit: input.limit,
      ...(cursor === undefined ? {} : { cursor }), ...(input.training_id === undefined ? {} : { trainingId: input.training_id }),
      ...(input.status === undefined ? {} : { status: input.status }) });
    const page = rows.slice(0, input.limit); const last = page.at(-1);
    return { data: page.map(mapCertificate), nextCursor: rows.length > input.limit && last !== undefined
      ? this.#cursors.encode({ organizationId, resource: "certificates", createdAt: last.created_at, id: last.id }) : null };
  }

  async revokeCertificate(context: TenantAuthorizationContext, certificateId: string, input: RevokeCertificateRequest,
    requestId: string): Promise<AdminCertificate> {
    const outcome = await runAuditedTransaction(this.options.database, async (transaction) => {
      const result = await revokeAdminCertificateInTransaction(transaction, { organizationId: context.organizationId,
        certificateId, reason: input.reason, revokedAt: (this.options.now ?? (() => new Date()))() });
      const audit: NewAuditRecord | null = result.kind === "REVOKED" ? { organizationId: context.organizationId,
        actorUserId: context.actorUserId, actorMembershipId: context.actorMembershipId,
        action: "CERTIFICATE_REVOKED", resourceType: "certificate", resourceId: certificateId,
        requestId, metadata: null } : null;
      return { result, audit };
    });
    if (outcome.kind === "NOT_FOUND") throw new ApplicationError("NOT_FOUND", "The requested resource was not found.", 404);
    if (outcome.kind === "CONFLICT") throw new ApplicationError("CONFLICT", "The requested operation conflicts with existing data.", 409);
    return mapCertificate(outcome.certificate);
  }
}
