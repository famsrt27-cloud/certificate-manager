import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";

import type { Database, JobStatus, JsonValue, RecordStatus } from "./types.js";

export interface CreateProjectInput { readonly name: string; readonly slug: string }
export interface UpdateProjectInput { readonly name?: string | undefined; readonly slug?: string | undefined }
export interface CreateTrainingInput {
  readonly project_id: string; readonly name: string; readonly code: string;
  readonly start_date?: string | null | undefined; readonly end_date?: string | null | undefined;
}
export interface UpdateTrainingInput {
  readonly name?: string | undefined; readonly code?: string | undefined;
  readonly start_date?: string | null | undefined; readonly end_date?: string | null | undefined;
}
export interface UpdateParticipantInput {
  readonly display_name?: string | undefined; readonly external_reference?: string | null | undefined;
}
export interface ImportRowValidationIssue { readonly code: string; readonly field: string }

export interface ResourceCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface ListInput {
  readonly organizationId: string;
  readonly limit: number;
  readonly cursor?: ResourceCursor;
  readonly status?: RecordStatus;
}

export const createProject = async (database: Kysely<Database>, organizationId: string, input: CreateProjectInput) =>
  database.insertInto("projects").values({ organization_id: organizationId, name: input.name, slug: input.slug })
    .returning(["id", "name", "slug", "status", "created_at"]).executeTakeFirstOrThrow();

export const findProject = async (database: Kysely<Database>, organizationId: string, projectId: string) =>
  database.selectFrom("projects").select(["id", "name", "slug", "status", "created_at"])
    .where("organization_id", "=", organizationId).where("id", "=", projectId).executeTakeFirst();

export const listProjects = async (database: Kysely<Database>, input: ListInput) => {
  let query = database.selectFrom("projects").select(["id", "name", "slug", "status", "created_at"])
    .where("organization_id", "=", input.organizationId);
  if (input.status !== undefined) query = query.where("status", "=", input.status);
  if (input.cursor !== undefined) query = query.where((expression) => expression.or([
    expression("created_at", "<", input.cursor!.createdAt),
    expression.and([expression("created_at", "=", input.cursor!.createdAt), expression("id", "<", input.cursor!.id)])
  ]));
  return query.orderBy("created_at", "desc").orderBy("id", "desc").limit(input.limit + 1).execute();
};

export const updateProject = async (database: Kysely<Database>, organizationId: string, projectId: string, input: UpdateProjectInput) =>
  database.updateTable("projects").set({ ...input, updated_at: new Date() })
    .where("organization_id", "=", organizationId).where("id", "=", projectId).where("status", "!=", "ARCHIVED")
    .returning(["id", "name", "slug", "status", "created_at"]).executeTakeFirst();

export const archiveProject = async (database: Kysely<Database>, organizationId: string, projectId: string) =>
  database.updateTable("projects").set({ status: "ARCHIVED", updated_at: new Date() })
    .where("organization_id", "=", organizationId).where("id", "=", projectId)
    .returning(["id", "name", "slug", "status", "created_at"]).executeTakeFirst();

export const createTraining = async (database: Kysely<Database>, organizationId: string, input: CreateTrainingInput) =>
  database.insertInto("trainings").columns(["organization_id", "project_id", "name", "code", "start_date", "end_date"])
    .expression((expression) => expression.selectFrom("projects").select([
      expression.val(organizationId).as("organization_id"), "id as project_id", expression.val(input.name).as("name"),
      expression.val(input.code).as("code"), expression.val(input.start_date ?? null).as("start_date"),
      expression.val(input.end_date ?? null).as("end_date")
    ]).where("id", "=", input.project_id).where("organization_id", "=", organizationId).where("status", "=", "ACTIVE"))
    .returning(["id", "project_id", "name", "code", "start_date", "end_date", "status", "created_at"])
    .executeTakeFirst();

export const findTraining = async (database: Kysely<Database>, organizationId: string, trainingId: string) =>
  database.selectFrom("trainings").select(["id", "project_id", "name", "code", "start_date", "end_date", "status", "created_at"])
    .where("organization_id", "=", organizationId).where("id", "=", trainingId).executeTakeFirst();

export const listTrainings = async (database: Kysely<Database>, input: ListInput & { readonly projectId?: string }) => {
  let query = database.selectFrom("trainings").select([
    "id", "project_id", "name", "code", "start_date", "end_date", "status", "created_at"
  ]).where("organization_id", "=", input.organizationId);
  if (input.status !== undefined) query = query.where("status", "=", input.status);
  if (input.projectId !== undefined) query = query.where("project_id", "=", input.projectId);
  if (input.cursor !== undefined) query = query.where((expression) => expression.or([
    expression("created_at", "<", input.cursor!.createdAt),
    expression.and([expression("created_at", "=", input.cursor!.createdAt), expression("id", "<", input.cursor!.id)])
  ]));
  return query.orderBy("created_at", "desc").orderBy("id", "desc").limit(input.limit + 1).execute();
};

export const updateTraining = async (database: Kysely<Database>, organizationId: string, trainingId: string, input: UpdateTrainingInput) =>
  database.updateTable("trainings").set({ ...input, updated_at: new Date() })
    .where("organization_id", "=", organizationId).where("id", "=", trainingId).where("status", "!=", "ARCHIVED")
    .returning(["id", "project_id", "name", "code", "start_date", "end_date", "status", "created_at"]).executeTakeFirst();

export const archiveTraining = async (database: Kysely<Database>, organizationId: string, trainingId: string) =>
  database.updateTable("trainings").set({ status: "ARCHIVED", updated_at: new Date() })
    .where("organization_id", "=", organizationId).where("id", "=", trainingId)
    .returning(["id", "project_id", "name", "code", "start_date", "end_date", "status", "created_at"]).executeTakeFirst();

export const findParticipant = async (database: Kysely<Database>, organizationId: string, participantId: string) =>
  database.selectFrom("participants").select(["id", "display_name", "external_reference", "created_at"])
    .where("organization_id", "=", organizationId).where("id", "=", participantId).executeTakeFirst();

export const listParticipants = async (database: Kysely<Database>, input: Omit<ListInput, "status"> & { readonly trainingId?: string }) => {
  let query = database.selectFrom("participants as participant")
    .select(["participant.id", "participant.display_name", "participant.external_reference", "participant.created_at"])
    .where("participant.organization_id", "=", input.organizationId);
  if (input.trainingId !== undefined) query = query.innerJoin("training_participants as relation", (join) => join
    .onRef("relation.participant_id", "=", "participant.id").onRef("relation.organization_id", "=", "participant.organization_id")
    .on("relation.training_id", "=", input.trainingId!).on("relation.status", "=", "ACTIVE"));
  if (input.cursor !== undefined) query = query.where((expression) => expression.or([
    expression("participant.created_at", "<", input.cursor!.createdAt),
    expression.and([
      expression("participant.created_at", "=", input.cursor!.createdAt), expression("participant.id", "<", input.cursor!.id)
    ])
  ]));
  return query.orderBy("participant.created_at", "desc").orderBy("participant.id", "desc").limit(input.limit + 1).execute();
};

export const updateParticipant = async (database: Kysely<Database>, organizationId: string, participantId: string, input: UpdateParticipantInput) =>
  database.transaction().execute(async (transaction) => {
    if (input.external_reference !== undefined && input.external_reference !== null) {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`${organizationId}:${input.external_reference}`}, 0))`.execute(transaction);
      const conflict = await transaction.selectFrom("participants").select("id").where("organization_id", "=", organizationId)
        .where("external_reference", "=", input.external_reference).where("id", "!=", participantId).executeTakeFirst();
      if (conflict !== undefined) return { conflict: true as const, participant: undefined };
    }
    const participant = await transaction.updateTable("participants").set({ ...input, updated_at: new Date() })
      .where("organization_id", "=", organizationId).where("id", "=", participantId)
      .returning(["id", "display_name", "external_reference", "created_at"]).executeTakeFirst();
    return { conflict: false as const, participant };
  });

export interface CreateParticipantImportInput {
  readonly jobId: string;
  readonly organizationId: string;
  readonly trainingId: string;
  readonly idempotencyKey: string;
  readonly requestedByMembershipId: string;
  readonly sourceStorageKey: string;
  readonly originalFilename: string;
  readonly contentSha256: Uint8Array;
  readonly detectedMimeType: string;
  readonly sizeBytes: number;
}

export const findParticipantImportByIdempotency = async (database: Kysely<Database>, organizationId: string, idempotencyKey: string) =>
  database.selectFrom("jobs as job")
    .innerJoin("participant_import_jobs as detail", (join) => join
      .onRef("detail.job_id", "=", "job.id")
      .onRef("detail.organization_id", "=", "job.organization_id"))
    .select(["job.id", "job.status", "detail.training_id", "detail.content_sha256"])
    .where("job.organization_id", "=", organizationId)
    .where("job.job_type", "=", "PARTICIPANT_IMPORT")
    .where("job.idempotency_key", "=", idempotencyKey)
    .executeTakeFirst();

export const createParticipantImport = async (database: Kysely<Database>, input: CreateParticipantImportInput) =>
  database.transaction().execute(async (transaction) => {
    const training = await transaction.selectFrom("trainings").select("id").where("organization_id", "=", input.organizationId)
      .where("id", "=", input.trainingId).where("status", "=", "ACTIVE").executeTakeFirst();
    if (training === undefined) return false;
    await transaction.insertInto("jobs").values({
      id: input.jobId, organization_id: input.organizationId, job_type: "PARTICIPANT_IMPORT",
      idempotency_key: input.idempotencyKey, requested_by_membership_id: input.requestedByMembershipId
    }).execute();
    await transaction.insertInto("participant_import_jobs").values({
      job_id: input.jobId, organization_id: input.organizationId, training_id: input.trainingId,
      source_storage_key: input.sourceStorageKey, original_filename: input.originalFilename,
      content_sha256: input.contentSha256, detected_mime_type: input.detectedMimeType, size_bytes: String(input.sizeBytes)
    }).execute();
    return true;
  });

export interface ParticipantImportRecord {
  readonly jobId: string;
  readonly organizationId: string;
  readonly trainingId: string;
  readonly sourceStorageKey: string;
  readonly detectedMimeType: string;
  readonly contentSha256: Uint8Array;
  readonly sizeBytes: number;
  readonly status: JobStatus;
  readonly confirmedAt: Date | null;
  readonly maxAttempts: number;
  readonly attemptCount: number;
}

export const findParticipantImport = async (database: Kysely<Database>, organizationId: string, jobId: string): Promise<ParticipantImportRecord | undefined> => {
  const row = await database.selectFrom("participant_import_jobs as detail")
    .innerJoin("jobs as job", (join) => join.onRef("job.id", "=", "detail.job_id").onRef("job.organization_id", "=", "detail.organization_id"))
    .select(["detail.job_id", "detail.organization_id", "detail.training_id", "detail.source_storage_key",
      "detail.detected_mime_type", "detail.content_sha256", "detail.size_bytes", "detail.confirmed_at",
      "job.status", "job.max_attempts", "job.attempt_count"])
    .where("detail.organization_id", "=", organizationId).where("detail.job_id", "=", jobId).executeTakeFirst();
  return row === undefined ? undefined : {
    jobId: row.job_id, organizationId: row.organization_id, trainingId: row.training_id,
    sourceStorageKey: row.source_storage_key, detectedMimeType: row.detected_mime_type, status: row.status,
    contentSha256: row.content_sha256, sizeBytes: Number(row.size_bytes),
    confirmedAt: row.confirmed_at, maxAttempts: row.max_attempts, attemptCount: row.attempt_count
  };
};

export interface StagedImportRowInput {
  readonly rowNumber: number;
  readonly displayName: string | null;
  readonly externalReference: string | null;
  readonly status: "VALID" | "INVALID";
  readonly validationErrors: readonly ImportRowValidationIssue[];
}

export const stageParticipantImportRows = async (database: Kysely<Database>, importJob: ParticipantImportRecord, rows: readonly StagedImportRowInput[]) =>
  database.transaction().execute(async (transaction) => {
    const locked = await transaction.selectFrom("jobs").select("status").where("organization_id", "=", importJob.organizationId)
      .where("id", "=", importJob.jobId).forUpdate().executeTakeFirst();
    if (locked?.status === "AWAITING_CONFIRMATION" || locked?.status === "SUCCEEDED") return false;
    await transaction.deleteFrom("participant_import_rows").where("organization_id", "=", importJob.organizationId)
      .where("job_id", "=", importJob.jobId).execute();
    if (rows.length > 0) await transaction.insertInto("participant_import_rows").values(rows.map((row) => ({
      organization_id: importJob.organizationId, job_id: importJob.jobId, row_number: row.rowNumber,
      display_name: row.displayName, external_reference: row.externalReference, status: row.status,
      validation_errors: sql<JsonValue>`${JSON.stringify(row.validationErrors)}::jsonb`
    }))).execute();
    await transaction.updateTable("jobs").set({
      status: "AWAITING_CONFIRMATION", progress_completed: rows.length, progress_total: rows.length,
      started_at: new Date(), last_error_code: null, updated_at: new Date()
    }).where("organization_id", "=", importJob.organizationId).where("id", "=", importJob.jobId).execute();
    return true;
  });

export const failParticipantImport = async (database: Kysely<Database>, organizationId: string, jobId: string,
  status: "FAILED" | "DEAD_LETTER", errorCode: string) => database.updateTable("jobs").set({
  status, last_error_code: errorCode,
  completed_at: new Date(), updated_at: new Date()
}).where("organization_id", "=", organizationId).where("id", "=", jobId)
  .where("status", "not in", ["SUCCEEDED", "CANCELLED"]).execute();

export const recordParticipantImportAttempt = async (database: Kysely<Database>, organizationId: string, jobId: string) =>
  database.updateTable("jobs").set({
    attempt_count: sql`least(attempt_count + 1, max_attempts)`,
    started_at: new Date(),
    updated_at: new Date()
  }).where("organization_id", "=", organizationId).where("id", "=", jobId)
    .where("job_type", "=", "PARTICIPANT_IMPORT").execute();

export const inspectParticipantImport = async (database: Kysely<Database>, organizationId: string, jobId: string,
  limit: number, cursor?: ResourceCursor) => {
  const job = await database.selectFrom("jobs").select([
    "id", "job_type", "status", "progress_completed", "progress_total", "attempt_count", "last_error_code"
  ]).where("organization_id", "=", organizationId).where("id", "=", jobId)
    .where("job_type", "=", "PARTICIPANT_IMPORT").executeTakeFirst();
  if (job === undefined) return undefined;
  const counts = await database.selectFrom("participant_import_rows").select([
    sql<number>`count(*) filter (where status in ('VALID','IMPORTED'))::int`.as("valid"),
    sql<number>`count(*) filter (where status in ('INVALID','FAILED'))::int`.as("invalid")
  ]).where("organization_id", "=", organizationId).where("job_id", "=", jobId).executeTakeFirstOrThrow();
  let query = database.selectFrom("participant_import_rows").select([
    "id", "row_number", "display_name", "external_reference", "status", "validation_errors", "created_at"
  ]).where("organization_id", "=", organizationId).where("job_id", "=", jobId);
  if (cursor !== undefined) query = query.where((expression) => expression.or([
    expression("created_at", ">", cursor.createdAt),
    expression.and([expression("created_at", "=", cursor.createdAt), expression("id", ">", cursor.id)])
  ]));
  const rows = await query.orderBy("created_at", "asc").orderBy("id", "asc").limit(limit + 1).execute();
  return { job, counts, rows };
};

export const confirmParticipantImport = async (database: Kysely<Database>, organizationId: string, jobId: string) =>
  database.transaction().execute(async (transaction) => {
    const job = await transaction.selectFrom("jobs").select("status").where("organization_id", "=", organizationId)
      .where("id", "=", jobId).where("job_type", "=", "PARTICIPANT_IMPORT").forUpdate().executeTakeFirst();
    if (job === undefined) return "NOT_FOUND" as const;
    const detail = await transaction.selectFrom("participant_import_jobs").select("confirmed_at")
      .where("organization_id", "=", organizationId).where("job_id", "=", jobId).executeTakeFirstOrThrow();
    if (detail.confirmed_at !== null) return "ALREADY_CONFIRMED" as const;
    if (job.status !== "AWAITING_CONFIRMATION") return "INVALID_STATE" as const;
    const valid = await transaction.selectFrom("participant_import_rows").select(sql<number>`count(*)::int`.as("count"))
      .where("organization_id", "=", organizationId).where("job_id", "=", jobId).where("status", "=", "VALID")
      .executeTakeFirstOrThrow();
    if (valid.count === 0) return "NO_VALID_ROWS" as const;
    const now = new Date();
    await transaction.updateTable("participant_import_jobs").set({ confirmed_at: now })
      .where("organization_id", "=", organizationId).where("job_id", "=", jobId).execute();
    await transaction.updateTable("jobs").set({ status: "QUEUED", queued_at: now, completed_at: null, updated_at: now })
      .where("organization_id", "=", organizationId).where("id", "=", jobId).execute();
    return "CONFIRMED" as const;
  });

export const revertParticipantImportConfirmation = async (database: Kysely<Database>, organizationId: string, jobId: string) =>
  database.transaction().execute(async (transaction) => {
    await transaction.updateTable("participant_import_jobs").set({ confirmed_at: null })
      .where("organization_id", "=", organizationId).where("job_id", "=", jobId).execute();
    await transaction.updateTable("jobs").set({ status: "AWAITING_CONFIRMATION", updated_at: new Date() })
      .where("organization_id", "=", organizationId).where("id", "=", jobId).where("status", "=", "QUEUED").execute();
  });

export const findJob = async (database: Kysely<Database>, organizationId: string, jobId: string) =>
  database.selectFrom("jobs").select(["id", "job_type", "status", "progress_completed", "progress_total", "attempt_count", "last_error_code"])
    .where("organization_id", "=", organizationId).where("id", "=", jobId).executeTakeFirst();

const importOneRow = async (transaction: Transaction<Database>, importJob: ParticipantImportRecord,
  row: { id: string; display_name: string | null; external_reference: string | null }): Promise<void> => {
  if (row.display_name === null) throw new Error("Validated import row had no display name");
  let participantId: string;
  if (row.external_reference !== null) {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`${importJob.organizationId}:${row.external_reference}`}, 0))`.execute(transaction);
    const matches = await transaction.selectFrom("participants").select("id").where("organization_id", "=", importJob.organizationId)
      .where("external_reference", "=", row.external_reference).limit(2).execute();
    if (matches.length > 1) throw new Error("IMPORT_REFERENCE_CONFLICT");
    if (matches[0] === undefined) {
      participantId = (await transaction.insertInto("participants").values({ organization_id: importJob.organizationId,
        external_reference: row.external_reference, display_name: row.display_name }).returning("id").executeTakeFirstOrThrow()).id;
    } else {
      participantId = matches[0].id;
      await transaction.updateTable("participants").set({ display_name: row.display_name, updated_at: new Date() })
        .where("organization_id", "=", importJob.organizationId).where("id", "=", participantId).execute();
    }
  } else {
    participantId = (await transaction.insertInto("participants").values({ organization_id: importJob.organizationId,
      external_reference: null, display_name: row.display_name }).returning("id").executeTakeFirstOrThrow()).id;
  }
  await transaction.insertInto("training_participants").values({ organization_id: importJob.organizationId,
    training_id: importJob.trainingId, participant_id: participantId, source_import_job_id: importJob.jobId })
    .onConflict((conflict) => conflict.columns(["organization_id", "training_id", "participant_id"]).doUpdateSet({
      status: "ACTIVE", updated_at: new Date()
    })).execute();
  await transaction.updateTable("participant_import_rows").set({ status: "IMPORTED", participant_id: participantId })
    .where("organization_id", "=", importJob.organizationId).where("id", "=", row.id).execute();
};

export const applyParticipantImport = async (database: Kysely<Database>, importJob: ParticipantImportRecord) =>
  database.transaction().execute(async (transaction) => {
    const job = await transaction.selectFrom("jobs").select(["status", "attempt_count", "max_attempts"])
      .where("organization_id", "=", importJob.organizationId).where("id", "=", importJob.jobId).forUpdate().executeTakeFirst();
    if (job?.status === "SUCCEEDED") return false;
    if (job?.status !== "QUEUED" || importJob.confirmedAt === null) throw new Error("IMPORT_CONFIRMATION_STATE_INVALID");
    await transaction.updateTable("jobs").set({ status: "RUNNING", updated_at: new Date() }).where("organization_id", "=", importJob.organizationId)
      .where("id", "=", importJob.jobId).execute();
    const rows = await transaction.selectFrom("participant_import_rows").select(["id", "display_name", "external_reference"])
      .where("organization_id", "=", importJob.organizationId).where("job_id", "=", importJob.jobId)
      .where("status", "=", "VALID").orderBy("row_number").execute();
    let completed = 0;
    for (const row of rows) { await importOneRow(transaction, importJob, row); completed += 1; }
    await transaction.updateTable("jobs").set({ status: "SUCCEEDED", progress_completed: completed, progress_total: completed,
      completed_at: new Date(), last_error_code: null, updated_at: new Date() })
      .where("organization_id", "=", importJob.organizationId).where("id", "=", importJob.jobId).execute();
    await transaction.deleteFrom("participant_import_rows").where("organization_id", "=", importJob.organizationId)
      .where("job_id", "=", importJob.jobId).execute();
    return true;
  });

export const cleanupExpiredParticipantImports = async (database: Kysely<Database>, cutoff: Date): Promise<readonly string[]> =>
  database.transaction().execute(async (transaction) => {
    const expired = await transaction.selectFrom("participant_import_jobs as detail")
      .innerJoin("jobs as job", (join) => join.onRef("job.id", "=", "detail.job_id")
        .onRef("job.organization_id", "=", "detail.organization_id"))
      .select(["job.id", "job.organization_id", "job.status", "detail.source_storage_key"])
      .where("job.created_at", "<", cutoff)
      .where("job.status", "in", ["AWAITING_CONFIRMATION", "SUCCEEDED", "FAILED", "DEAD_LETTER", "CANCELLED"])
      .forUpdate().execute();
    if (expired.length === 0) return [];
    const awaitingIds = expired.filter((row) => row.status === "AWAITING_CONFIRMATION").map((row) => row.id);
    if (awaitingIds.length > 0) await transaction.updateTable("jobs").set({
      status: "CANCELLED", completed_at: new Date(), last_error_code: "IMPORT_CONFIRMATION_EXPIRED", updated_at: new Date()
    }).where("id", "in", awaitingIds).execute();
    await transaction.deleteFrom("participant_import_rows").where("job_id", "in", expired.map((row) => row.id)).execute();
    return expired.map((row) => row.source_storage_key);
  });
