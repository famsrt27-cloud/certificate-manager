import { randomUUID } from "node:crypto";

import { DashboardSummaryResponseSchema } from "@certificate-platform/contracts";
import { closeDatabase, createDatabase, insertAuditRecord } from "@certificate-platform/database";
import type { EffectiveIdentity } from "@certificate-platform/domain";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApi } from "../../src/app.js";
import { ApplicationError } from "../../src/errors/application-error.js";
import type { AuthenticatedContext, AuthenticationService } from "../../src/modules/auth/authentication-service.js";
import { OrganizationAuthorizationService } from "../../src/modules/auth/organization-authorization-service.js";
import { DashboardService } from "../../src/modules/dashboard/dashboard-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = databaseUrl !== undefined && new URL(databaseUrl).pathname.toLowerCase().includes("test");

describe.skipIf(!enabled)("organization dashboard integration", () => {
  const database = createDatabase({ connectionString: databaseUrl!, maxConnections: 3 });
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const otherMembershipId = randomUUID();
  const allReadPermissions = ["organization:read", "project:read", "training:read", "participant:read", "template:read", "certificate:read", "job:read"];
  let identity: EffectiveIdentity;
  let authenticated: AuthenticatedContext | null;
  let app: ReturnType<typeof buildApi>;

  beforeAll(async () => {
    const projectId = randomUUID();
    const archivedProjectId = randomUUID();
    const otherProjectId = randomUUID();
    const trainingId = randomUUID();
    const archivedTrainingId = randomUUID();
    const otherTrainingId = randomUUID();
    const templateId = randomUUID();
    const archivedTemplateId = randomUUID();
    const otherTemplateId = randomUUID();
    const versionId = randomUUID();
    const archivedTemplateVersionId = randomUUID();
    const otherVersionId = randomUUID();

    await database.insertInto("users").values({ id: userId, email: `dashboard-${randomUUID()}@example.invalid`, password_hash: "synthetic" }).execute();
    await database.insertInto("organizations").values([
      { id: organizationId, name: "Dashboard Tenant" },
      { id: otherOrganizationId, name: "Foreign Dashboard Tenant" }
    ]).execute();
    await database.insertInto("organization_memberships").values([
      { id: membershipId, organization_id: organizationId, user_id: userId },
      { id: otherMembershipId, organization_id: otherOrganizationId, user_id: userId }
    ]).execute();
    await database.insertInto("projects").values([
      { id: projectId, organization_id: organizationId, name: "Active", slug: `active-${randomUUID()}` },
      { id: archivedProjectId, organization_id: organizationId, name: "Archived", slug: `archived-${randomUUID()}`, status: "ARCHIVED" },
      { id: otherProjectId, organization_id: otherOrganizationId, name: "Foreign", slug: `foreign-${randomUUID()}` }
    ]).execute();
    await database.insertInto("trainings").values([
      { id: trainingId, organization_id: organizationId, project_id: projectId, name: "Active training", code: `A-${randomUUID()}` },
      { id: archivedTrainingId, organization_id: organizationId, project_id: archivedProjectId, name: "Archived training", code: `R-${randomUUID()}`, status: "ARCHIVED" },
      { id: otherTrainingId, organization_id: otherOrganizationId, project_id: otherProjectId, name: "Foreign training", code: `F-${randomUUID()}` }
    ]).execute();
    await database.insertInto("certificate_templates").values([
      { id: templateId, organization_id: organizationId, name: "Active template" },
      { id: archivedTemplateId, organization_id: organizationId, name: "Archived template", status: "ARCHIVED" },
      { id: otherTemplateId, organization_id: otherOrganizationId, name: "Foreign template" }
    ]).execute();
    await database.insertInto("template_versions").values([
      { id: versionId, organization_id: organizationId, template_id: templateId, version: 1, definition_json: {}, status: "PUBLISHED", published_at: new Date() },
      { id: archivedTemplateVersionId, organization_id: organizationId, template_id: archivedTemplateId, version: 1, definition_json: {}, status: "PUBLISHED", published_at: new Date() },
      { id: otherVersionId, organization_id: otherOrganizationId, template_id: otherTemplateId, version: 1, definition_json: {}, status: "PUBLISHED", published_at: new Date() }
    ]).execute();

    for (let index = 0; index < 3; index += 1) {
      const participantId = randomUUID();
      await database.insertInto("participants").values({ id: participantId, organization_id: organizationId, display_name: `Synthetic ${index}` }).execute();
      await database.insertInto("training_participants").values({ organization_id: organizationId, training_id: trainingId, participant_id: participantId }).execute();
      await database.insertInto("certificates").values({ organization_id: organizationId, training_id: trainingId,
        participant_id: participantId, template_version_id: versionId, certificate_number: `DASH-${randomUUID()}`, verification_key_kid: "key-dashboard" }).execute();
    }
    const foreignParticipantId = randomUUID();
    await database.insertInto("participants").values({ id: foreignParticipantId, organization_id: otherOrganizationId,
      display_name: "Foreign private person", external_reference: "FOREIGN-SECRET" }).execute();
    await database.insertInto("training_participants").values({ organization_id: otherOrganizationId, training_id: otherTrainingId,
      participant_id: foreignParticipantId }).execute();
    await database.insertInto("jobs").values([
      { organization_id: organizationId, job_type: "PARTICIPANT_IMPORT", status: "QUEUED", idempotency_key: `q-${randomUUID()}`, requested_by_membership_id: membershipId },
      { organization_id: organizationId, job_type: "PARTICIPANT_IMPORT", status: "RUNNING", idempotency_key: `r-${randomUUID()}`, requested_by_membership_id: membershipId },
      { organization_id: organizationId, job_type: "PARTICIPANT_IMPORT", status: "FAILED", idempotency_key: `f-${randomUUID()}`, requested_by_membership_id: membershipId, last_error_code: "SENSITIVE_INTERNAL_DETAIL" },
      { organization_id: organizationId, job_type: "PARTICIPANT_IMPORT", status: "DEAD_LETTER", idempotency_key: `d-${randomUUID()}`, requested_by_membership_id: membershipId },
      { organization_id: otherOrganizationId, job_type: "PARTICIPANT_IMPORT", status: "DEAD_LETTER", idempotency_key: `foreign-${randomUUID()}`, requested_by_membership_id: otherMembershipId }
    ]).execute();

    identity = { user: { id: userId, email: "dashboard@example.invalid" }, systemRoles: [], memberships: [{
      id: membershipId, organizationId, organizationName: "Dashboard Tenant", roles: ["ORG_ADMIN"], permissions: allReadPermissions
    }] };
    authenticated = { sessionId: "s".repeat(43), session: { version: 1, userId, csrfToken: "c".repeat(43),
      authorizationVersion: "a".repeat(64), createdAt: 1, lastSeenAt: 1, absoluteExpiresAt: 2 }, identity };
    const authentication = { authenticate: async () => authenticated,
      validateStateChangingRequest: () => { throw new ApplicationError("REQUEST_FORBIDDEN", "Forbidden", 403); }
    } as unknown as AuthenticationService;
    const authorization = new OrganizationAuthorizationService(authentication, { write: (event) => insertAuditRecord(database, event) });
    app = buildApi({ dependencies: { checkDatabase: async () => undefined, checkRedis: async () => undefined },
      readinessTimeoutMs: 100, logger: false, dashboard: { authentication, authorization, service: new DashboardService(database) } });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await closeDatabase(database);
  });

  const getDashboard = (selectedOrganizationId = organizationId) => request(app.server).get("/api/admin/dashboard")
    .set("x-organization-id", selectedOrganizationId);

  it("requires authentication, a valid organization header, membership, and organization read permission", async () => {
    const prior = authenticated;
    authenticated = null;
    expect((await getDashboard()).status).toBe(401);
    authenticated = prior;
    expect((await request(app.server).get("/api/admin/dashboard")).status).toBe(400);
    expect((await request(app.server).get("/api/admin/dashboard").set("x-organization-id", "not-a-uuid")).status).toBe(400);
    authenticated = { ...prior!, identity: { ...identity, memberships: [] } };
    expect((await getDashboard()).status).toBe(403);
    authenticated = { ...prior!, identity: { ...identity, memberships: [{ ...identity.memberships[0]!, permissions: ["project:read"] }] } };
    expect((await getDashboard()).status).toBe(403);
    authenticated = prior;
  });

  it("returns accurate aggregates with archived semantics and no cross-tenant or sensitive data", async () => {
    const response = await getDashboard();
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(DashboardSummaryResponseSchema.parse(response.body).data).toEqual({
      projects: { active: 1, total: 2 },
      trainings: { active: 1, total: 2 },
      participants: { total: 3 },
      templates: { active: 1, published_versions: 1 },
      certificates: { available: 0, in_progress: 3, revoked: 0 },
      jobs: { queued: 1, running: 1, failed: 1, dead_letter: 1 }
    });
    expect(JSON.stringify(response.body)).not.toMatch(/FOREIGN|SECRET|SENSITIVE|storage|token|session|external_reference|last_error/iu);
  });

  it("uses effective permissions for TEMPLATE_MANAGER, CERTIFICATE_MANAGER, and VIEWER summaries", async () => {
    const prior = authenticated;
    const cases = [
      { role: "TEMPLATE_MANAGER", permissions: ["organization:read", "project:read", "training:read", "template:read"],
        sections: ["projects", "trainings", "templates"] },
      { role: "CERTIFICATE_MANAGER", permissions: allReadPermissions,
        sections: ["projects", "trainings", "participants", "templates", "certificates", "jobs"] },
      { role: "VIEWER", permissions: allReadPermissions,
        sections: ["projects", "trainings", "participants", "templates", "certificates", "jobs"] }
    ] as const;
    for (const testCase of cases) {
      authenticated = { ...prior!, identity: { ...identity, memberships: [{ ...identity.memberships[0]!,
        roles: [testCase.role], permissions: testCase.permissions }] } };
      const response = await getDashboard();
      expect(response.status).toBe(200);
      expect(Object.keys(response.body.data)).toEqual(testCase.sections);
    }
    authenticated = prior;
  });

  it("denies selection of an organization outside the authenticated membership", async () => {
    expect((await getDashboard(otherOrganizationId)).status).toBe(403);
  });
});
