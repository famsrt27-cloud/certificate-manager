import { describe, expect, it } from "vitest";
import { CERTIFICATE_GENERATION_JOB_NAME, CERTIFICATE_GENERATION_QUEUE_NAME, CertificateGenerationJobPayloadSchema } from "./certificate-generation-queue.js";

describe("certificate generation queue contract", () => {
  it("uses stable names and a minimal persisted-work payload", () => {
    expect(CERTIFICATE_GENERATION_QUEUE_NAME).toBe("certificate-generation-v1");
    expect(CERTIFICATE_GENERATION_JOB_NAME).toBe("generate-certificates");
    expect(CertificateGenerationJobPayloadSchema.parse({ version: 1, job_id: "00000000-0000-4000-8000-000000000001", organization_id: "00000000-0000-4000-8000-000000000002" })).toEqual(expect.objectContaining({ version: 1 }));
  });
  it("rejects PII, tokens and secrets", () => {
    expect(CertificateGenerationJobPayloadSchema.safeParse({ version: 1, job_id: "00000000-0000-4000-8000-000000000001", organization_id: "00000000-0000-4000-8000-000000000002", display_name: "PII", token: "secret" }).success).toBe(false);
  });
});
