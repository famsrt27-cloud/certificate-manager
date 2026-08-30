import {
  AdminOrganizationIdSchema,
  OrganizationPublicSearchResponseSchema,
  UpdateOrganizationPublicSearchRequestSchema
} from "@certificate-platform/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { ApplicationError } from "../errors/application-error.js";
import type { AuthenticationService } from "../modules/auth/authentication-service.js";
import { readAdminSessionCookie } from "../modules/auth/cookie.js";
import type { OrganizationAuthorizationService } from "../modules/auth/organization-authorization-service.js";
import type { OrganizationSettingsService } from "../modules/dashboard/organization-settings-service.js";

export interface AdminOrganizationSettingsRouteOptions {
  readonly authentication: AuthenticationService;
  readonly authorization: OrganizationAuthorizationService;
  readonly service: OrganizationSettingsService;
}

const authenticate = async (request: FastifyRequest, service: AuthenticationService) => {
  const context = await service.authenticate(readAdminSessionCookie(request.headers.cookie), request.id);
  if (context === null) throw new ApplicationError("AUTHENTICATION_REQUIRED", "Authentication is required.", 401);
  return context;
};

export const registerAdminOrganizationSettingsRoutes = (
  app: FastifyInstance,
  options: AdminOrganizationSettingsRouteOptions
): void => {
  app.patch("/api/admin/organizations/current", async (request, reply) => {
    const organization = AdminOrganizationIdSchema.safeParse(request.headers["x-organization-id"]);
    const input = UpdateOrganizationPublicSearchRequestSchema.safeParse(request.body);
    if (!organization.success || !input.success) {
      throw new ApplicationError("VALIDATION_FAILED", "The request could not be processed.", 400);
    }
    const authenticated = await authenticate(request, options.authentication);
    const context = await options.authorization.requirePermission({
      authenticated,
      organizationId: organization.data,
      permission: "organization:update",
      requestId: request.id,
      stateChanging: true,
      ...(typeof request.headers.origin === "string" ? { origin: request.headers.origin } : {}),
      ...(typeof request.headers["x-csrf-token"] === "string"
        ? { csrfToken: request.headers["x-csrf-token"] } : {})
    });
    const data = await options.service.updatePublicCertificateSearch(
      context,
      input.data.public_certificate_search_enabled,
      request.id
    );
    return reply.header("cache-control", "no-store")
      .send(OrganizationPublicSearchResponseSchema.parse({ data, meta: { request_id: request.id } }));
  });
};
