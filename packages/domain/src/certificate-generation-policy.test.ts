import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  canPlanCertificateIssue,
  canonicalizeGenerationParticipantIds,
  createCertificateGenerationRequestFingerprint,
  isCertificateLifecycleTransitionAllowed,
  validateRendererRevision
} from "./certificate-generation-policy.js";

const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex");

describe("certificate generation policy", () => {
  it("creates the same request fingerprint for the same exact participant set regardless of order", () => {
    const organizationId = randomUUID();
    const trainingId = randomUUID();
    const templateVersionId = randomUUID();
    const first = randomUUID();
    const second = randomUUID();

    const left = createCertificateGenerationRequestFingerprint({
      organizationId,
      trainingId,
      templateVersionId,
      selectionMode: "EXPLICIT",
      resolvedParticipantIds: [first, second]
    });
    const right = createCertificateGenerationRequestFingerprint({
      organizationId: organizationId.toUpperCase(),
      trainingId,
      templateVersionId,
      selectionMode: "EXPLICIT",
      resolvedParticipantIds: [second, first]
    });

    expect(hex(left)).toBe(hex(right));
    expect(left).toHaveLength(32);
  });

  it("binds the fingerprint to request identity, selection mode and exact target set", () => {
    const organizationId = randomUUID();
    const trainingId = randomUUID();
    const templateVersionId = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    const base = {
      organizationId,
      trainingId,
      templateVersionId,
      selectionMode: "EXPLICIT" as const,
      resolvedParticipantIds: [first]
    };

    const baseline = hex(createCertificateGenerationRequestFingerprint(base));
    expect(hex(createCertificateGenerationRequestFingerprint({
      ...base,
      trainingId: randomUUID()
    }))).not.toBe(baseline);
    expect(hex(createCertificateGenerationRequestFingerprint({
      ...base,
      templateVersionId: randomUUID()
    }))).not.toBe(baseline);
    expect(hex(createCertificateGenerationRequestFingerprint({
      ...base,
      selectionMode: "ALL_ELIGIBLE"
    }))).not.toBe(baseline);
    expect(hex(createCertificateGenerationRequestFingerprint({
      ...base,
      resolvedParticipantIds: [first, second]
    }))).not.toBe(baseline);
  });

  it("rejects empty or duplicate resolved participant sets", () => {
    const duplicate = randomUUID();
    expect(() => canonicalizeGenerationParticipantIds([])).toThrow();
    expect(() => canonicalizeGenerationParticipantIds([duplicate, duplicate])).toThrow();
  });

  it("validates renderer revisions without making them part of the client request fingerprint", () => {
    expect(validateRendererRevision("pdfkit-qrcode-v1")).toBe("pdfkit-qrcode-v1");
    expect(validateRendererRevision("renderer.2026-08-24")).toBe("renderer.2026-08-24");
    expect(() => validateRendererRevision("PDFKit V1")).toThrow();
    expect(() => validateRendererRevision("")).toThrow();
  });

  it("mirrors the locked Phase 5 lifecycle policy", () => {
    expect(isCertificateLifecycleTransitionAllowed("DRAFT", "GENERATING")).toBe(true);
    expect(isCertificateLifecycleTransitionAllowed("GENERATING", "AVAILABLE")).toBe(true);
    expect(isCertificateLifecycleTransitionAllowed("AVAILABLE", "REVOKED")).toBe(true);
    expect(isCertificateLifecycleTransitionAllowed("AVAILABLE", "AVAILABLE")).toBe(true);
    expect(isCertificateLifecycleTransitionAllowed("REVOKED", "AVAILABLE")).toBe(false);
    expect(isCertificateLifecycleTransitionAllowed("DRAFT", "AVAILABLE")).toBe(false);
    expect(isCertificateLifecycleTransitionAllowed("AVAILABLE", "ARCHIVED")).toBe(false);
  });

  it("requires an explicit reissue operation after historical revocation", () => {
    expect(canPlanCertificateIssue("INITIAL_ISSUE", [])).toBe(true);
    expect(canPlanCertificateIssue("INITIAL_ISSUE", ["REVOKED"])).toBe(false);
    expect(canPlanCertificateIssue("REISSUE", ["REVOKED"])).toBe(true);
    expect(canPlanCertificateIssue("REISSUE", [])).toBe(false);
    expect(canPlanCertificateIssue("REISSUE", ["REVOKED", "REVOKED"])).toBe(true);
    expect(canPlanCertificateIssue("REISSUE", ["REVOKED", "AVAILABLE"])).toBe(false);
  });
});
