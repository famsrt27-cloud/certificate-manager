import { AdminOrganizationIdSchema, DashboardSummaryResponseSchema } from "@certificate-platform/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { ApplicationError } from "../errors/application-error.js";
import type { AuthenticationService } from "../modules/auth/authentication-service.js";
import { readAdminSessionCookie } from "../modules/auth/cookie.js";
import type { OrganizationAuthorizationService } from "../modules/auth/organization-authorization-service.js";
import type { DashboardService } from "../modules/dashboard/dashboard-service.js";

export interface AdminDashboardRouteOptions {
  readonly authentication: AuthenticationService;
  readonly authorization: OrganizationAuthorizationService;
  readonly service: DashboardService;
}

const authenticate = async (request: FastifyRequest, service: AuthenticationService) => {
  try {
    const context = await service.authenticate(readAdminSessionCookie(request.headers.cookie), request.id);
    if (context === null) throw new ApplicationError("AUTHENTICATION_REQUIRED", "Authentication is required.", 401);
    return context;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    request.log.error({ error_code: "AUTH_STATE_UNAVAILABLE" }, "authentication state unavailable");
    throw new ApplicationError("SERVICE_UNAVAILABLE", "The service is temporarily unavailable.", 503);
  }
};

export const registerAdminDashboardRoutes = (app: FastifyInstance, options: AdminDashboardRouteOptions): void => {
  app.get("/api/admin/dashboard", async (request, reply) => {
    const authenticated = await authenticate(request, options.authentication);
    const organization = AdminOrganizationIdSchema.safeParse(request.headers["x-organization-id"]);
    if (!organization.success) throw new ApplicationError("VALIDATION_FAILED", "The request could not be processed.", 400);
    const context = await options.authorization.requirePermission({
      authenticated,
      organizationId: organization.data,
      permission: "organization:read",
      requestId: request.id,
      stateChanging: false
    });
    if (context.membership === null) throw new ApplicationError("FORBIDDEN", "The operation is not permitted.", 403);
    const data = await options.service.getSummary(context.organizationId, context.membership);
    return reply.header("cache-control", "no-store").send(DashboardSummaryResponseSchema.parse({
      data,
      meta: { request_id: request.id }
    }));
  });
};
