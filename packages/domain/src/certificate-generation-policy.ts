import { createHash } from "node:crypto";

export const CERTIFICATE_GENERATION_REQUEST_FINGERPRINT_VERSION = 1 as const;
export const CERTIFICATE_RENDERER_REVISION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type CertificateGenerationSelectionMode = "ALL_ELIGIBLE" | "EXPLICIT";
export type CertificateIssueOperation = "INITIAL_ISSUE" | "REISSUE";
export type CertificateLifecycleStatus =
  | "DRAFT"
  | "GENERATING"
  | "ISSUED"
  | "AVAILABLE"
  | "REVOKED"
  | "ARCHIVED";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const canonicalUuid = (value: string, field: string): string => {
  const canonical = value.trim().toLowerCase();
  if (!uuidPattern.test(canonical)) throw new Error(`${field} must be a UUID`);
  return canonical;
};

export const validateRendererRevision = (value: string): string => {
  if (!CERTIFICATE_RENDERER_REVISION_PATTERN.test(value)) {
    throw new Error("renderer revision is invalid");
  }
  return value;
};

export const canonicalizeGenerationParticipantIds = (
  participantIds: readonly string[]
): readonly string[] => {
  if (participantIds.length === 0) throw new Error("at least one resolved participant is required");

  const canonical = participantIds.map((value) => canonicalUuid(value, "participant id")).sort();
  for (let index = 1; index < canonical.length; index += 1) {
    if (canonical[index] === canonical[index - 1]) {
      throw new Error("resolved participant ids must be unique");
    }
  }

  return Object.freeze(canonical);
};

export interface CertificateGenerationRequestFingerprintInput {
  readonly organizationId: string;
  readonly trainingId: string;
  readonly templateVersionId: string;
  readonly selectionMode: CertificateGenerationSelectionMode;
  readonly resolvedParticipantIds: readonly string[];
}

export const createCertificateGenerationRequestFingerprint = (
  input: CertificateGenerationRequestFingerprintInput
): Uint8Array => {
  const organizationId = canonicalUuid(input.organizationId, "organization id");
  const trainingId = canonicalUuid(input.trainingId, "training id");
  const templateVersionId = canonicalUuid(input.templateVersionId, "template version id");
  const participantIds = canonicalizeGenerationParticipantIds(input.resolvedParticipantIds);

  const hash = createHash("sha256");
  hash.update(`CERTIFICATE_GENERATION_REQUEST_V${CERTIFICATE_GENERATION_REQUEST_FINGERPRINT_VERSION}\0`);
  hash.update(organizationId);
  hash.update("\0");
  hash.update(trainingId);
  hash.update("\0");
  hash.update(templateVersionId);
  hash.update("\0");
  hash.update(input.selectionMode);
  hash.update("\0");
  hash.update(String(participantIds.length));

  for (const participantId of participantIds) {
    hash.update("\0");
    hash.update(participantId);
  }

  return new Uint8Array(hash.digest());
};

export const isCertificateLifecycleTransitionAllowed = (
  from: CertificateLifecycleStatus,
  to: CertificateLifecycleStatus
): boolean => {
  if (from === to) return true;
  if (from === "DRAFT" && to === "GENERATING") return true;
  if (from === "GENERATING" && to === "AVAILABLE") return true;
  if (from === "AVAILABLE" && to === "REVOKED") return true;
  return false;
};

export const canPlanCertificateIssue = (
  operation: CertificateIssueOperation,
  existingStatuses: readonly CertificateLifecycleStatus[]
): boolean => {
  if (existingStatuses.some((status) => status !== "REVOKED")) return false;
  if (operation === "INITIAL_ISSUE") return existingStatuses.length === 0;
  return existingStatuses.length > 0;
};
