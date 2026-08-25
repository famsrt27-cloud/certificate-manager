import { AdminOrganizationIdSchema, CertificateGenerationQueuedResponseSchema, GenerateCertificatesRequestSchema, IdempotencyKeySchema } from "@certificate-platform/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApplicationError } from "../errors/application-error.js";
import type { AuthenticationService } from "../modules/auth/authentication-service.js";
import { readAdminSessionCookie } from "../modules/auth/cookie.js";
import type { OrganizationAuthorizationService } from "../modules/auth/organization-authorization-service.js";
import type { PhaseFiveService } from "../modules/phase-five/phase-five-service.js";

const Params = z.object({ trainingId: z.uuid() }).strict();
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => { const result = schema.safeParse(value); if (!result.success) throw new ApplicationError("VALIDATION_FAILED", "The request could not be processed.", 400); return result.data; };
export interface AdminPhaseFiveRouteOptions { authentication: AuthenticationService; authorization: OrganizationAuthorizationService; service: PhaseFiveService }
export const registerAdminPhaseFiveRoutes = (app: FastifyInstance, options: AdminPhaseFiveRouteOptions): void => {
  app.post("/api/admin/trainings/:trainingId/certificates/generate", async (request: FastifyRequest, reply) => {
    const authenticated = await options.authentication.authenticate(readAdminSessionCookie(request.headers.cookie), request.id);
    if (authenticated === null) throw new ApplicationError("AUTHENTICATION_REQUIRED", "Authentication is required.", 401);
    const organizationId = parse(AdminOrganizationIdSchema, request.headers["x-organization-id"]);
    const context = await options.authorization.requirePermission({ authenticated, organizationId, permission: "certificate:generate", requestId: request.id, stateChanging: true,
      ...(typeof request.headers.origin === "string" ? { origin: request.headers.origin } : {}), ...(typeof request.headers["x-csrf-token"] === "string" ? { csrfToken: request.headers["x-csrf-token"] } : {}) });
    const { trainingId } = parse(Params, request.params); const key = parse(IdempotencyKeySchema, request.headers["idempotency-key"]);
    const data = await options.service.generate(context, trainingId, key, parse(GenerateCertificatesRequestSchema, request.body));
    return reply.status(202).header("cache-control", "no-store").send(CertificateGenerationQueuedResponseSchema.parse({ data, meta: { request_id: request.id } }));
  });
};
