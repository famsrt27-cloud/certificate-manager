import {
  authorizeOrganizationPermission,
  type AuditWriter,
  type EffectiveMembership
} from "@certificate-platform/domain";

import { ApplicationError } from "../../errors/application-error.js";
import type { AuthenticatedContext, AuthenticationService } from "./authentication-service.js";

export interface OrganizationAuthorizationRequest {
  readonly authenticated: AuthenticatedContext;
  readonly organizationId: string;
  readonly permission: string;
  readonly requestId: string;
  readonly stateChanging: boolean;
  readonly origin?: string;
  readonly csrfToken?: string;
  readonly allowSuperAdmin?: boolean;
}

export interface TenantAuthorizationContext {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly actorMembershipId: string | null;
  readonly membership: EffectiveMembership | null;
  readonly superAdmin: boolean;
}

export class OrganizationAuthorizationService {
  readonly #authentication: AuthenticationService;
  readonly #audit: AuditWriter;

  constructor(authentication: AuthenticationService, audit: AuditWriter) {
    this.#authentication = authentication;
    this.#audit = audit;
  }

  async requirePermission(request: OrganizationAuthorizationRequest): Promise<TenantAuthorizationContext> {
    if (request.stateChanging) {
      this.#authentication.validateStateChangingRequest(
        request.authenticated,
        request.origin,
        request.csrfToken
      );
    }
    const decision = authorizeOrganizationPermission(
      request.authenticated.identity,
      request.organizationId,
      request.permission,
      request.allowSuperAdmin ?? false
    );
    if (!decision.allowed) {
      const membership = request.authenticated.identity.memberships.find(
        (candidate) => candidate.organizationId === request.organizationId
      );
      await this.#audit.write({
        organizationId: membership?.organizationId ?? null,
        actorUserId: request.authenticated.identity.user.id,
        actorMembershipId: membership?.id ?? null,
        action: "AUTHORIZATION_DENIED",
        resourceType: "authorization",
        resourceId: null,
        requestId: request.requestId,
        metadata: { reason: decision.reason, permission: request.permission }
      });
      throw new ApplicationError("FORBIDDEN", "The requested operation is not permitted.", 403);
    }
    return {
      organizationId: request.organizationId,
      actorUserId: request.authenticated.identity.user.id,
      actorMembershipId: decision.membership?.id ?? null,
      membership: decision.membership,
      superAdmin: decision.superAdmin
    };
  }
}
