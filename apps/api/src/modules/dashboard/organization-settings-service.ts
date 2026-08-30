import {
  runAuditedTransaction,
  updateOrganizationPublicCertificateSearch,
  type DatabaseClient
} from "@certificate-platform/database";

import { ApplicationError } from "../../errors/application-error.js";
import type { TenantAuthorizationContext } from "../auth/organization-authorization-service.js";

export class OrganizationSettingsService {
  readonly #database: DatabaseClient;

  constructor(database: DatabaseClient) {
    this.#database = database;
  }

  async updatePublicCertificateSearch(
    context: TenantAuthorizationContext,
    enabled: boolean,
    requestId: string
  ) {
    const result = await runAuditedTransaction(this.#database, async (transaction) => {
      const row = await updateOrganizationPublicCertificateSearch(transaction, context.organizationId, enabled);
      return {
        result: row,
        audit: row === undefined ? null : {
          organizationId: context.organizationId,
          actorUserId: context.actorUserId,
          actorMembershipId: context.actorMembershipId,
          action: "ORGANIZATION_PUBLIC_SEARCH_UPDATED" as const,
          resourceType: "organization" as const,
          resourceId: context.organizationId,
          requestId,
          metadata: null
        }
      };
    });
    if (result === undefined) {
      throw new ApplicationError("NOT_FOUND", "The requested resource was not found.", 404);
    }
    return { public_certificate_search_enabled: result.public_certificate_search_enabled };
  }
}
