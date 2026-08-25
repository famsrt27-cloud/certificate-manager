import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

export type Timestamp = ColumnType<Date, Date | string, Date | string>;
export type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
export type NullableTimestamp = ColumnType<Date | null, Date | string | null, Date | string | null>;
export type DateOnly = ColumnType<Date, string, string>;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type RecordStatus = "ACTIVE" | "INACTIVE" | "ARCHIVED";
export type CertificateStatus = "DRAFT" | "GENERATING" | "ISSUED" | "AVAILABLE" | "REVOKED" | "ARCHIVED";
export type TemplateVersionStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";
export type RoleCode = "SUPER_ADMIN" | "ORG_ADMIN" | "CERTIFICATE_MANAGER" | "TEMPLATE_MANAGER" | "VIEWER";
export type JobType = "PARTICIPANT_IMPORT" | "CERTIFICATE_GENERATION";
export type JobStatus = "QUEUED" | "RUNNING" | "AWAITING_CONFIRMATION" | "SUCCEEDED" | "FAILED" | "DEAD_LETTER" | "CANCELLED";
export type JobItemStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "DEAD_LETTER" | "SKIPPED";
export type CertificateGenerationSelectionMode = "ALL_ELIGIBLE" | "EXPLICIT";
export type ImportRowStatus = "PENDING" | "VALID" | "INVALID" | "IMPORTED" | "FAILED";
export type TemplateAssetStatus = "QUARANTINED" | "ACTIVE" | "REJECTED" | "ARCHIVED";

interface TimestampedTable {
  id: Generated<string>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface OrganizationsTable extends TimestampedTable {
  name: string;
  status: Generated<RecordStatus>;
}

export interface UsersTable extends TimestampedTable {
  email: string;
  password_hash: string;
  status: Generated<RecordStatus>;
}

export interface OrganizationMembershipsTable extends TimestampedTable {
  organization_id: string;
  user_id: string;
  status: Generated<RecordStatus>;
}

export interface RolesTable {
  code: RoleCode;
  scope: "SYSTEM" | "ORGANIZATION";
  description: string;
}

export interface PermissionsTable {
  code: string;
  description: string;
}

export interface RolePermissionsTable {
  role: RoleCode;
  permission_code: string;
}

export interface UserSystemRolesTable {
  user_id: string;
  role: RoleCode;
  granted_by_user_id: string | null;
  granted_at: GeneratedTimestamp;
}

export interface MembershipRolesTable {
  membership_id: string;
  organization_id: string;
  role: RoleCode;
  granted_by_user_id: string | null;
  granted_at: GeneratedTimestamp;
}

export interface ProjectsTable extends TimestampedTable {
  organization_id: string;
  name: string;
  slug: string;
  status: Generated<RecordStatus>;
}

export interface TrainingsTable extends TimestampedTable {
  organization_id: string;
  project_id: string;
  name: string;
  code: string;
  start_date: DateOnly | null;
  end_date: DateOnly | null;
  status: Generated<RecordStatus>;
}

export interface ParticipantsTable extends TimestampedTable {
  organization_id: string;
  external_reference: string | null;
  display_name: string;
}

export interface CertificateTemplatesTable extends TimestampedTable {
  organization_id: string;
  name: string;
  status: Generated<RecordStatus>;
}

export interface TemplateAssetsTable {
  id: Generated<string>;
  organization_id: string;
  template_id: string;
  storage_key: string;
  original_filename: string;
  content_sha256: Uint8Array;
  detected_mime_type: string;
  size_bytes: string;
  width_px: number | null;
  height_px: number | null;
  status: Generated<TemplateAssetStatus>;
  created_by_membership_id: string;
  created_at: GeneratedTimestamp;
}

export interface TemplateVersionsTable {
  id: Generated<string>;
  organization_id: string;
  template_id: string;
  version: number;
  definition_json: JsonValue;
  status: Generated<TemplateVersionStatus>;
  published_at: NullableTimestamp;
  created_at: GeneratedTimestamp;
}

export interface TemplateVersionAssetsTable {
  template_version_id: string;
  asset_id: string;
  organization_id: string;
  template_id: string;
  created_at: GeneratedTimestamp;
}

export interface JobsTable extends TimestampedTable {
  organization_id: string;
  job_type: JobType;
  status: Generated<JobStatus>;
  idempotency_key: string;
  progress_completed: Generated<number>;
  progress_total: Generated<number>;
  attempt_count: Generated<number>;
  max_attempts: Generated<number>;
  last_error_code: string | null;
  requested_by_membership_id: string;
  queued_at: GeneratedTimestamp;
  started_at: NullableTimestamp;
  completed_at: NullableTimestamp;
}

export interface ParticipantImportJobsTable {
  job_id: string;
  organization_id: string;
  training_id: string;
  source_storage_key: string;
  original_filename: string;
  content_sha256: Uint8Array;
  detected_mime_type: string;
  size_bytes: string;
  confirmed_at: NullableTimestamp;
  source_cleanup_requested_at: NullableTimestamp;
  source_cleanup_completed_at: NullableTimestamp;
  source_cleanup_attempt_count: Generated<number>;
  source_cleanup_last_attempt_at: NullableTimestamp;
  source_cleanup_last_error_code: string | null;
  retention_cleanup_completed_at: NullableTimestamp;
}

export interface QueueOutboxTable {
  id: Generated<string>;
  organization_id: string;
  message_type: string;
  deduplication_key: string;
  payload_json: JsonValue;
  dispatched_at: NullableTimestamp;
  attempt_count: Generated<number>;
  last_attempt_at: NullableTimestamp;
  last_error_code: string | null;
  created_at: GeneratedTimestamp;
}

export interface StorageCleanupOutboxTable {
  id: Generated<string>;
  organization_id: string;
  object_key: string;
  not_before: Timestamp;
  attempt_count: Generated<number>;
  last_attempt_at: NullableTimestamp;
  last_error_code: string | null;
  created_at: GeneratedTimestamp;
}

export interface ParticipantImportRowsTable {
  id: Generated<string>;
  organization_id: string;
  job_id: string;
  row_number: number;
  display_name: string | null;
  external_reference: string | null;
  status: Generated<ImportRowStatus>;
  validation_errors: JsonValue | null;
  participant_id: string | null;
  created_at: GeneratedTimestamp;
}

export interface TrainingParticipantsTable extends TimestampedTable {
  organization_id: string;
  training_id: string;
  participant_id: string;
  source_import_job_id: string | null;
  status: Generated<RecordStatus>;
}

export interface CertificateGenerationJobsTable {
  job_id: string;
  organization_id: string;
  training_id: string;
  template_version_id: string;
  generation_revision: Generated<number>;
  selection_mode: CertificateGenerationSelectionMode;
  request_fingerprint: Uint8Array;
  renderer_revision: string;
}

export interface CertificatesTable extends TimestampedTable {
  public_identifier: Generated<string>;
  organization_id: string;
  training_id: string;
  participant_id: string;
  template_version_id: string;
  certificate_number: string;
  verification_key_kid: string | null;
  status: Generated<CertificateStatus>;
  generation_revision: Generated<number>;
  pdf_storage_key: string | null;
  pdf_content_sha256: Uint8Array | null;
  pdf_size_bytes: string | null;
  pdf_mime_type: string | null;
  issued_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  revocation_reason: string | null;
}

export interface CertificateIssuanceSnapshotsTable {
  certificate_id: string;
  organization_id: string;
  snapshot_schema_version: Generated<number>;
  recipient_display_name: string;
  project_name: string;
  training_name: string;
  training_code: string;
  issued_at: Timestamp;
  created_at: GeneratedTimestamp;
}

export interface CertificateGenerationItemsTable extends TimestampedTable {
  organization_id: string;
  job_id: string;
  certificate_id: string;
  generation_revision: number;
  status: Generated<JobItemStatus>;
  attempt_count: Generated<number>;
  last_error_code: string | null;
}

export interface AuditLogsTable {
  id: Generated<string>;
  organization_id: string | null;
  actor_user_id: string | null;
  actor_membership_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  request_id: string;
  metadata: JsonValue | null;
  created_at: GeneratedTimestamp;
}

export interface VerificationEventsTable {
  id: Generated<string>;
  organization_id: string | null;
  certificate_id: string | null;
  result: string;
  request_id: string;
  network_fingerprint: string | null;
  created_at: GeneratedTimestamp;
}

export type DownloadEventsTable = VerificationEventsTable;

export interface Database {
  organizations: OrganizationsTable;
  users: UsersTable;
  organization_memberships: OrganizationMembershipsTable;
  roles: RolesTable;
  permissions: PermissionsTable;
  role_permissions: RolePermissionsTable;
  user_system_roles: UserSystemRolesTable;
  membership_roles: MembershipRolesTable;
  projects: ProjectsTable;
  trainings: TrainingsTable;
  participants: ParticipantsTable;
  certificate_templates: CertificateTemplatesTable;
  template_assets: TemplateAssetsTable;
  template_versions: TemplateVersionsTable;
  template_version_assets: TemplateVersionAssetsTable;
  jobs: JobsTable;
  participant_import_jobs: ParticipantImportJobsTable;
  queue_outbox: QueueOutboxTable;
  storage_cleanup_outbox: StorageCleanupOutboxTable;
  participant_import_rows: ParticipantImportRowsTable;
  training_participants: TrainingParticipantsTable;
  certificate_generation_jobs: CertificateGenerationJobsTable;
  certificates: CertificatesTable;
  certificate_issuance_snapshots: CertificateIssuanceSnapshotsTable;
  certificate_generation_items: CertificateGenerationItemsTable;
  audit_logs: AuditLogsTable;
  verification_events: VerificationEventsTable;
  download_events: DownloadEventsTable;
}

export type Certificate = Selectable<CertificatesTable>;
export type NewCertificate = Insertable<CertificatesTable>;
export type CertificateUpdate = Updateable<CertificatesTable>;
