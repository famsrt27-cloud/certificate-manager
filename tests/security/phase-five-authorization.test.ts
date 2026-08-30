import type { EffectiveIdentity } from "@certificate-platform/domain";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { buildApi } from "../../apps/api/src/app.js";
import { ApplicationError } from "../../apps/api/src/errors/application-error.js";
import type { AuthenticatedContext, AuthenticationService } from "../../apps/api/src/modules/auth/authentication-service.js";
import { OrganizationAuthorizationService } from "../../apps/api/src/modules/auth/organization-authorization-service.js";
import type { PhaseFiveService } from "../../apps/api/src/modules/phase-five/phase-five-service.js";
import type { AdminCertificatePdfService } from "../../apps/api/src/modules/phase-six/admin-certificate-pdf-service.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const otherOrganizationId = "00000000-0000-4000-8000-000000000002";
const trainingId = "00000000-0000-4000-8000-000000000003";
const versionId = "00000000-0000-4000-8000-000000000004";
const certificateId = "00000000-0000-4000-8000-000000000008";
const certificate = { id: certificateId, certificate_number: "CERT-SECURITY", status: "AVAILABLE" as const,
  recipient_display_name: "Synthetic Recipient", project_name: "Synthetic Project", training_name: "Synthetic Training",
  training_code: "SEC-1", training_id: trainingId, issued_at: "2026-08-30T00:00:00.000Z", revoked_at: null,
  revocation_reason: null };

const buildFixture = (permissions: readonly string[], roles: readonly string[] = ["VIEWER"]) => {
  const identity: EffectiveIdentity = {
    user: { id: "00000000-0000-4000-8000-000000000005", email: "synthetic@example.invalid" },
    systemRoles: [],
    memberships: [{
      id: "00000000-0000-4000-8000-000000000006",
      organizationId,
      organizationName: "Synthetic Tenant",
      roles,
      permissions
    }]
  };
  const authenticated: AuthenticatedContext = {
    sessionId: "s".repeat(43),
    session: { version: 1, userId: identity.user.id, csrfToken: "c".repeat(43), authorizationVersion: "a".repeat(64),
      createdAt: 1, lastSeenAt: 1, absoluteExpiresAt: 2 },
    identity
  };
  const authentication = {
    authenticate: vi.fn().mockResolvedValue(authenticated),
    validateStateChangingRequest: vi.fn((_context, origin: string | undefined, csrfToken: string | undefined) => {
      if (origin !== "https://admin.example.invalid" || csrfToken !== "c".repeat(43)) {
        throw new ApplicationError("REQUEST_FORBIDDEN", "The request could not be authorized.", 403);
      }
    })
  } as unknown as AuthenticationService;
  const generate = vi.fn().mockResolvedValue({ job_id: "00000000-0000-4000-8000-000000000007", status: "QUEUED" });
  const listCertificates = vi.fn().mockResolvedValue({ data: [certificate], nextCursor: null });
  const revokeCertificate = vi.fn().mockResolvedValue({ ...certificate, status: "REVOKED", revoked_at: "2026-08-30T01:00:00.000Z", revocation_reason: "Issued incorrectly" });
  const service = { generate, listCertificates, revokeCertificate } as unknown as PhaseFiveService;
  const readPdf = vi.fn().mockResolvedValue({ bytes: Buffer.from("%PDF-test"), filename: "certificate-CERT-SECURITY.pdf" });
  const app = buildApi({
    dependencies: { checkDatabase: vi.fn(), checkRedis: vi.fn() },
    readinessTimeoutMs: 100,
    logger: false,
    phaseFive: {
      authentication,
      authorization: new OrganizationAuthorizationService(authentication, { write: vi.fn().mockResolvedValue(undefined) }),
      service,
      certificatePdf: { read: readPdf } as unknown as AdminCertificatePdfService
    }
  });
  return { app, generate, listCertificates, revokeCertificate, readPdf, authentication };
};

const generateRequest = (app: ReturnType<typeof buildApi>, selectedOrganizationId = organizationId) =>
  request(app.server).post(`/api/admin/trainings/${trainingId}/certificates/generate`)
    .set("x-organization-id", selectedOrganizationId)
    .set("origin", "https://admin.example.invalid")
    .set("x-csrf-token", "c".repeat(43))
    .set("idempotency-key", "synthetic-generation-key")
    .send({ template_version_id: versionId });

describe("Phase 5 authorization abuse cases", () => {
  it("blocks template-only and role-name-collision memberships from certificate generation", async () => {
    for (const roles of [["TEMPLATE_MANAGER"], ["SUPER_ADMIN"]]) {
      const fixture = buildFixture(["template:read", "template:update"], roles);
      await fixture.app.ready();
      expect((await generateRequest(fixture.app)).status).toBe(403);
      expect(fixture.generate).not.toHaveBeenCalled();
      await fixture.app.close();
    }
  });

  it("blocks a foreign organization selector before generation service access", async () => {
    const fixture = buildFixture(["certificate:generate"]);
    await fixture.app.ready();
    expect((await generateRequest(fixture.app, otherOrganizationId)).status).toBe(403);
    expect(fixture.generate).not.toHaveBeenCalled();
    await fixture.app.close();
  });

  it("validates Origin and CSRF before generation service access", async () => {
    const fixture = buildFixture(["certificate:generate"]);
    await fixture.app.ready();
    const response = await generateRequest(fixture.app).unset("x-csrf-token");
    expect(response.status).toBe(403);
    expect(fixture.generate).not.toHaveBeenCalled();
    await fixture.app.close();
  });

  it("requires certificate:read and blocks foreign tenant selectors before list access", async () => {
    for (const [permissions, selectedOrganization] of [[[] as string[], organizationId], [["certificate:read"], otherOrganizationId]] as const) {
      const fixture = buildFixture(permissions); await fixture.app.ready();
      expect((await request(fixture.app.server).get("/api/admin/certificates").set("x-organization-id", selectedOrganization)).status).toBe(403);
      expect(fixture.listCertificates).not.toHaveBeenCalled(); await fixture.app.close();
    }
  });

  it("requires certificate:revoke plus Origin and CSRF before revoke access", async () => {
    const missing = buildFixture(["certificate:read"]); await missing.app.ready();
    expect((await request(missing.app.server).post(`/api/admin/certificates/${certificateId}/revoke`)
      .set("x-organization-id", organizationId).set("origin", "https://admin.example.invalid").set("x-csrf-token", "c".repeat(43))
      .send({ reason: "Issued incorrectly" })).status).toBe(403); expect(missing.revokeCertificate).not.toHaveBeenCalled(); await missing.app.close();
    const protectedFixture = buildFixture(["certificate:revoke"]); await protectedFixture.app.ready();
    expect((await request(protectedFixture.app.server).post(`/api/admin/certificates/${certificateId}/revoke`)
      .set("x-organization-id", organizationId).set("origin", "https://admin.example.invalid")
      .send({ reason: "Issued incorrectly" })).status).toBe(403); expect(protectedFixture.revokeCertificate).not.toHaveBeenCalled(); await protectedFixture.app.close();
  });

  it("requires authentication, tenant selection, and certificate:download for PDF access", async () => {
    const missingPermission = buildFixture(["certificate:read"]); await missingPermission.app.ready();
    expect((await request(missingPermission.app.server).get(`/api/admin/certificates/${certificateId}/pdf`)
      .set("x-organization-id", organizationId)).status).toBe(403);
    expect(missingPermission.readPdf).not.toHaveBeenCalled(); await missingPermission.app.close();

    const missingTenant = buildFixture(["certificate:download"]); await missingTenant.app.ready();
    expect((await request(missingTenant.app.server).get(`/api/admin/certificates/${certificateId}/pdf`)).status).toBe(400);
    expect(missingTenant.readPdf).not.toHaveBeenCalled(); await missingTenant.app.close();

    const wrongTenant = buildFixture(["certificate:download"]); await wrongTenant.app.ready();
    expect((await request(wrongTenant.app.server).get(`/api/admin/certificates/${certificateId}/pdf`)
      .set("x-organization-id", otherOrganizationId)).status).toBe(403);
    expect(wrongTenant.readPdf).not.toHaveBeenCalled(); await wrongTenant.app.close();

    const unauthenticated = buildFixture(["certificate:download"]);
    vi.mocked(unauthenticated.authentication.authenticate).mockResolvedValue(null); await unauthenticated.app.ready();
    expect((await request(unauthenticated.app.server).get(`/api/admin/certificates/${certificateId}/pdf`)
      .set("x-organization-id", organizationId)).status).toBe(401);
    expect(unauthenticated.readPdf).not.toHaveBeenCalled(); await unauthenticated.app.close();
  });

  it("serves inline or attachment PDFs with safe headers and rejects malformed IDs and query values", async () => {
    const fixture = buildFixture(["certificate:download"]); await fixture.app.ready();
    for (const disposition of ["inline", "attachment"] as const) {
      const response = await request(fixture.app.server).get(`/api/admin/certificates/${certificateId}/pdf?disposition=${disposition}`)
        .set("x-organization-id", organizationId);
      expect(response.status).toBe(200); expect(response.headers["content-type"]).toMatch(/^application\/pdf/);
      expect(response.headers["content-disposition"]).toBe(`${disposition}; filename="certificate-CERT-SECURITY.pdf"`);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    }
    expect(fixture.readPdf).toHaveBeenCalledWith(organizationId, certificateId);
    expect((await request(fixture.app.server).get("/api/admin/certificates/not-a-uuid/pdf")
      .set("x-organization-id", organizationId)).status).toBe(400);
    expect((await request(fixture.app.server).get(`/api/admin/certificates/${certificateId}/pdf?disposition=unsafe`)
      .set("x-organization-id", organizationId)).status).toBe(400);
    await fixture.app.close();
  });
});
