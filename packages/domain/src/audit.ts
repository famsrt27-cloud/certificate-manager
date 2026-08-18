export const AUDIT_ACTIONS = [
  "AUTH_LOGIN_FAILED",
  "AUTH_LOGIN_SUCCEEDED",
  "AUTH_LOGOUT",
  "AUTH_SESSION_REVOKED",
  "AUTHORIZATION_DENIED",
  "PROJECT_CREATED",
  "PROJECT_UPDATED",
  "PROJECT_ARCHIVED",
  "TRAINING_CREATED",
  "TRAINING_UPDATED",
  "TRAINING_ARCHIVED",
  "PARTICIPANT_UPDATED",
  "PARTICIPANT_IMPORT_QUEUED",
  "PARTICIPANT_IMPORT_CONFIRMED",
  "TEMPLATE_CREATED",
  "TEMPLATE_UPDATED",
  "TEMPLATE_ARCHIVED",
  "TEMPLATE_VERSION_CREATED",
  "TEMPLATE_VERSION_UPDATED",
  "TEMPLATE_VERSION_DELETED",
  "TEMPLATE_VERSION_PUBLISHED",
  "TEMPLATE_VERSION_ARCHIVED",
  "TEMPLATE_ASSET_CREATED",
  "TEMPLATE_ASSET_ARCHIVED"
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEvent {
  readonly organizationId: string | null;
  readonly actorUserId: string | null;
  readonly actorMembershipId: string | null;
  readonly action: AuditAction;
  readonly resourceType: "authentication" | "authorization" | "project" | "training" | "participant" | "participant_import"
    | "template" | "template_version" | "template_asset";
  readonly resourceId: string | null;
  readonly requestId: string;
  readonly metadata:
    | null
    | { readonly reason: "INVALID_CREDENTIALS" | "RATE_LIMITED" }
    | { readonly reason: "AUTHORIZATION_CHANGED" | "USER_INACTIVE" | "SESSION_EXPIRED" }
    | { readonly reason: "NO_ACTIVE_MEMBERSHIP" | "MISSING_PERMISSION"; readonly permission: string };
}

export interface AuditWriter {
  write(event: AuditEvent): Promise<void>;
}
