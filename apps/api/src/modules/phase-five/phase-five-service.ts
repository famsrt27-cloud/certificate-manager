import type { GenerateCertificatesRequest } from "@certificate-platform/contracts";
import { planCertificateGeneration, type DatabaseClient } from "@certificate-platform/database";
import { ApplicationError } from "../../errors/application-error.js";
import type { TenantAuthorizationContext } from "../auth/organization-authorization-service.js";

export class PhaseFiveService {
  constructor(private readonly options: { database: DatabaseClient; verificationKeyKid: string; now?: () => Date }) {}
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
}
