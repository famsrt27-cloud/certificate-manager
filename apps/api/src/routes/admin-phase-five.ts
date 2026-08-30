import { AdminCertificateResponseSchema, AdminOrganizationIdSchema, CertificateGenerationQueuedResponseSchema,
  CertificateListQuerySchema, CertificateListResponseSchema, GenerateCertificatesRequestSchema, IdempotencyKeySchema,
  RevokeCertificateRequestSchema } from "@certificate-platform/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApplicationError } from "../errors/application-error.js";
import type { AuthenticationService } from "../modules/auth/authentication-service.js";
import { readAdminSessionCookie } from "../modules/auth/cookie.js";
import type { OrganizationAuthorizationService } from "../modules/auth/organization-authorization-service.js";
import type { PhaseFiveService } from "../modules/phase-five/phase-five-service.js";
import type { AdminCertificatePdfService } from "../modules/phase-six/admin-certificate-pdf-service.js";

const Params = z.object({ trainingId: z.uuid() }).strict();
const CertificateParams = z.object({ certificateId: z.uuid() }).strict();
const CertificatePdfQuery = z.object({ disposition: z.enum(["inline", "attachment"]).default("inline") }).strict();
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => { const result = schema.safeParse(value); if (!result.success) throw new ApplicationError("VALIDATION_FAILED", "The request could not be processed.", 400); return result.data; };
export interface AdminPhaseFiveRouteOptions { authentication: AuthenticationService; authorization: OrganizationAuthorizationService; service: PhaseFiveService; certificatePdf: AdminCertificatePdfService }
export const registerAdminPhaseFiveRoutes = (app: FastifyInstance, options: AdminPhaseFiveRouteOptions): void => {
  const authorize = async (request: FastifyRequest, permission: "certificate:read" | "certificate:generate" | "certificate:revoke" | "certificate:download", stateChanging: boolean) => {
    const authenticated = await options.authentication.authenticate(readAdminSessionCookie(request.headers.cookie), request.id);
    if (authenticated === null) throw new ApplicationError("AUTHENTICATION_REQUIRED", "Authentication is required.", 401);
    const organizationId = parse(AdminOrganizationIdSchema, request.headers["x-organization-id"]);
    return options.authorization.requirePermission({ authenticated, organizationId, permission, requestId: request.id, stateChanging,
      ...(typeof request.headers.origin === "string" ? { origin: request.headers.origin } : {}),
      ...(typeof request.headers["x-csrf-token"] === "string" ? { csrfToken: request.headers["x-csrf-token"] } : {}) });
  };

  app.get("/api/admin/certificates", async (request: FastifyRequest, reply) => {
    const context = await authorize(request, "certificate:read", false);
    const result = await options.service.listCertificates(context.organizationId, parse(CertificateListQuerySchema, request.query));
    return reply.header("cache-control", "no-store").send(CertificateListResponseSchema.parse({ data: result.data,
      meta: { request_id: request.id, next_cursor: result.nextCursor } }));
  });

  app.get("/api/admin/certificates/:certificateId/pdf", async (request: FastifyRequest, reply) => {
    const context = await authorize(request, "certificate:download", false);
    const { certificateId } = parse(CertificateParams, request.params);
    const { disposition } = parse(CertificatePdfQuery, request.query);
    const pdf = await options.certificatePdf.read(context.organizationId, certificateId);
    return reply.status(200)
      .header("content-type", "application/pdf")
      .header("content-disposition", `${disposition}; filename="${pdf.filename}"`)
      .header("cache-control", "private, no-store")
      .header("x-content-type-options", "nosniff")
      .send(Buffer.from(pdf.bytes));
  });

  app.post("/api/admin/trainings/:trainingId/certificates/generate", async (request: FastifyRequest, reply) => {
    const context = await authorize(request, "certificate:generate", true);
    const { trainingId } = parse(Params, request.params); const key = parse(IdempotencyKeySchema, request.headers["idempotency-key"]);
    const data = await options.service.generate(context, trainingId, key, request.id,
      parse(GenerateCertificatesRequestSchema, request.body));
    return reply.status(202).header("cache-control", "no-store").send(CertificateGenerationQueuedResponseSchema.parse({ data, meta: { request_id: request.id } }));
  });

  app.post("/api/admin/certificates/:certificateId/revoke", async (request: FastifyRequest, reply) => {
    const context = await authorize(request, "certificate:revoke", true);
    const { certificateId } = parse(CertificateParams, request.params);
    const data = await options.service.revokeCertificate(context, certificateId, parse(RevokeCertificateRequestSchema, request.body), request.id);
    return reply.header("cache-control", "no-store").send(AdminCertificateResponseSchema.parse({ data, meta: { request_id: request.id } }));
  });
};
