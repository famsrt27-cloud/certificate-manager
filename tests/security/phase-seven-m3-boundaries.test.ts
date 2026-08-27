import { randomUUID } from "node:crypto";

import { CERTIFICATE_GENERATION_REQUEST_MAX_PARTICIPANTS, GenerateCertificatesRequestSchema,
  LoginRequestSchema } from "@certificate-platform/contracts";
import { CERTIFICATE_GENERATION_MAX_PARTICIPANTS } from "@certificate-platform/domain";
import { CertificateGenerationJobPayloadSchema, ParticipantImportJobPayloadSchema } from "@certificate-platform/queue";
import { describe, expect, it } from "vitest";

const templateVersionId = "00000000-0000-4000-8000-000000000001";
const jobId = "00000000-0000-4000-8000-000000000002";
const organizationId = "00000000-0000-4000-8000-000000000003";

describe("Phase 7 M3 trust-changing input boundaries", () => {
  it("rejects trust-changing mass-assignment fields", () => {
    expect(LoginRequestSchema.safeParse({ email: "admin@example.invalid", password: "synthetic", role: "SUPER_ADMIN" }).success).toBe(false);
    expect(GenerateCertificatesRequestSchema.safeParse({ template_version_id: templateVersionId,
      organization_id: organizationId, status: "AVAILABLE", storage_key: "certificates/foreign.pdf" }).success).toBe(false);
  });

  it("bounds explicit certificate generation cardinality", () => {
    expect(CERTIFICATE_GENERATION_REQUEST_MAX_PARTICIPANTS).toBe(CERTIFICATE_GENERATION_MAX_PARTICIPANTS);
    const participantIds = Array.from({ length: CERTIFICATE_GENERATION_MAX_PARTICIPANTS + 1 }, () => randomUUID());
    expect(GenerateCertificatesRequestSchema.safeParse({ template_version_id: templateVersionId,
      participant_ids: participantIds }).success).toBe(false);
  });

  it("rejects wrong-version, foreign-shape, and oversized queue messages", () => {
    expect(CertificateGenerationJobPayloadSchema.safeParse({ version: 2, job_id: jobId, organization_id: organizationId }).success).toBe(false);
    expect(CertificateGenerationJobPayloadSchema.safeParse({ version: 1, job_id: jobId, organization_id: organizationId,
      verification_token: "v".repeat(4_096) }).success).toBe(false);
    expect(ParticipantImportJobPayloadSchema.safeParse({ version: 1, job_id: jobId, organization_id: organizationId,
      operation: "CONFIRM", participant_rows: [{ display_name: "Private Recipient" }] }).success).toBe(false);
  });
});
