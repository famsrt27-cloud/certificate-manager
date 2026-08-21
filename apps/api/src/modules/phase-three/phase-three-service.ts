import { createHash, randomUUID } from "node:crypto";

import type {
  CreateProjectRequest, CreateTrainingRequest, Participant, Project, Training,
  UpdateParticipantRequest, UpdateProjectRequest, UpdateTrainingRequest
} from "@certificate-platform/contracts";
import { ImportRowValidationErrorSchema } from "@certificate-platform/contracts";
import {
  archiveProject, archiveTraining, confirmParticipantImport, createParticipantImport, createProject, createTraining,
  findJob, findParticipant, findParticipantImportByIdempotency, findProject, findTraining,
  inspectParticipantImport, listParticipants, listProjects, listTrainings,
  updateParticipant, updateProject, updateTraining,
  type DatabaseClient
} from "@certificate-platform/database";
import type { AuditAction, AuditWriter } from "@certificate-platform/domain";
import type { PrivateObjectStorage } from "@certificate-platform/storage";
import { z } from "zod";

import { ApplicationError } from "../../errors/application-error.js";
import type { TenantAuthorizationContext } from "../auth/organization-authorization-service.js";
import { CursorCodec, type CursorResource } from "./cursor-codec.js";
import { validateParticipantImportUpload } from "./participant-import-upload.js";

const ImportErrorsSchema = z.array(ImportRowValidationErrorSchema);

const isUniqueViolation = (error: unknown): boolean => typeof error === "object" && error !== null
  && "code" in error && error.code === "23505";

const notFound = (): never => { throw new ApplicationError("NOT_FOUND", "The requested resource was not found.", 404); };
const conflict = (): never => { throw new ApplicationError("CONFLICT", "The requested operation conflicts with existing data.", 409); };

const participantImportRequestFingerprint = (
  organizationId: string,
  trainingId: string,
  contentSha256: Uint8Array
): string => {
  const hash = createHash("sha256");
  hash.update("PARTICIPANT_IMPORT\0");
  hash.update(organizationId.toLowerCase());
  hash.update("\0");
  hash.update(trainingId.toLowerCase());
  hash.update("\0");
  hash.update(contentSha256);
  return hash.digest("hex");
};

const mapProject = (row: { id: string; name: string; slug: string; status: Project["status"] }): Project => ({
  id: row.id, name: row.name, slug: row.slug, status: row.status
});
const mapDateOnly = (value: string | Date | null): string | null => value instanceof Date
  ? value.toISOString().slice(0, 10) : value;
const mapTraining = (row: { id: string; project_id: string; name: string; code: string; start_date: string | Date | null;
  end_date: string | Date | null; status: Training["status"] }): Training => ({
  id: row.id, project_id: row.project_id, name: row.name, code: row.code,
  start_date: mapDateOnly(row.start_date), end_date: mapDateOnly(row.end_date), status: row.status
});
const mapParticipant = (row: { id: string; display_name: string; external_reference: string | null }): Participant => ({
  id: row.id, display_name: row.display_name, external_reference: row.external_reference
});

export interface PhaseThreeServiceOptions {
  readonly database: DatabaseClient;
  readonly storage: PrivateObjectStorage;
  readonly audit: AuditWriter;
  readonly cursorSecret: string;
}

export class PhaseThreeService {
  readonly #database: DatabaseClient;
  readonly #storage: PrivateObjectStorage;
  readonly #audit: AuditWriter;
  readonly #cursors: CursorCodec;

  constructor(options: PhaseThreeServiceOptions) {
    this.#database = options.database;
    this.#storage = options.storage;
    this.#audit = options.audit;
    this.#cursors = new CursorCodec(options.cursorSecret);
  }

  async createProject(context: TenantAuthorizationContext, input: CreateProjectRequest, requestId: string): Promise<Project> {
    try {
      const project = mapProject(await createProject(this.#database, context.organizationId, input));
      await this.#writeAudit(context, "PROJECT_CREATED", "project", project.id, requestId);
      return project;
    } catch (error) {
      if (isUniqueViolation(error)) conflict();
      throw error;
    }
  }

  async getProject(organizationId: string, projectId: string): Promise<Project> {
    const row = await findProject(this.#database, organizationId, projectId);
    return row === undefined ? notFound() : mapProject(row);
  }

  async listProjects(organizationId: string, input: { limit: number; cursor?: string | undefined;
    status?: Project["status"] | undefined }) {
    const cursor = input.cursor === undefined ? undefined : this.#cursors.decode(input.cursor, organizationId, "projects");
    const rows = await listProjects(this.#database, { organizationId, limit: input.limit, ...(cursor === undefined ? {} : { cursor }),
      ...(input.status === undefined ? {} : { status: input.status }) });
    return this.#page(rows, input.limit, organizationId, "projects", mapProject);
  }

  async updateProject(context: TenantAuthorizationContext, projectId: string, input: UpdateProjectRequest, requestId: string): Promise<Project> {
    try {
      const row = await updateProject(this.#database, context.organizationId, projectId, input);
      if (row === undefined) return notFound();
      const project = mapProject(row);
      await this.#writeAudit(context, "PROJECT_UPDATED", "project", project.id, requestId);
      return project;
    } catch (error) {
      if (isUniqueViolation(error)) conflict();
      throw error;
    }
  }

  async archiveProject(context: TenantAuthorizationContext, projectId: string, requestId: string): Promise<Project> {
    const row = await archiveProject(this.#database, context.organizationId, projectId);
    if (row === undefined) return notFound();
    const project = mapProject(row);
    await this.#writeAudit(context, "PROJECT_ARCHIVED", "project", project.id, requestId);
    return project;
  }

  async createTraining(context: TenantAuthorizationContext, input: CreateTrainingRequest, requestId: string): Promise<Training> {
    try {
      const row = await createTraining(this.#database, context.organizationId, input);
      if (row === undefined) return notFound();
      const training = mapTraining(row);
      await this.#writeAudit(context, "TRAINING_CREATED", "training", training.id, requestId);
      return training;
    } catch (error) {
      if (isUniqueViolation(error)) conflict();
      throw error;
    }
  }

  async getTraining(organizationId: string, trainingId: string): Promise<Training> {
    const row = await findTraining(this.#database, organizationId, trainingId);
    return row === undefined ? notFound() : mapTraining(row);
  }

  async listTrainings(organizationId: string, input: { limit: number; cursor?: string | undefined;
    status?: Training["status"] | undefined; project_id?: string | undefined }) {
    const cursor = input.cursor === undefined ? undefined : this.#cursors.decode(input.cursor, organizationId, "trainings");
    const rows = await listTrainings(this.#database, { organizationId, limit: input.limit,
      ...(cursor === undefined ? {} : { cursor }), ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.project_id === undefined ? {} : { projectId: input.project_id }) });
    return this.#page(rows, input.limit, organizationId, "trainings", mapTraining);
  }

  async updateTraining(context: TenantAuthorizationContext, trainingId: string, input: UpdateTrainingRequest, requestId: string): Promise<Training> {
    const existing = await findTraining(this.#database, context.organizationId, trainingId);
    if (existing === undefined || existing.status === "ARCHIVED") return notFound();
    const startDate = input.start_date === undefined ? mapDateOnly(existing.start_date) : input.start_date;
    const endDate = input.end_date === undefined ? mapDateOnly(existing.end_date) : input.end_date;
    if (startDate !== null && endDate !== null && endDate < startDate) {
      throw new ApplicationError("VALIDATION_FAILED", "The request could not be processed.", 400);
    }
    try {
      const row = await updateTraining(this.#database, context.organizationId, trainingId, input);
      if (row === undefined) return notFound();
      const training = mapTraining(row);
      await this.#writeAudit(context, "TRAINING_UPDATED", "training", training.id, requestId);
      return training;
    } catch (error) {
      if (isUniqueViolation(error)) conflict();
      throw error;
    }
  }

  async archiveTraining(context: TenantAuthorizationContext, trainingId: string, requestId: string): Promise<Training> {
    const row = await archiveTraining(this.#database, context.organizationId, trainingId);
    if (row === undefined) return notFound();
    const training = mapTraining(row);
    await this.#writeAudit(context, "TRAINING_ARCHIVED", "training", training.id, requestId);
    return training;
  }

  async getParticipant(organizationId: string, participantId: string): Promise<Participant> {
    const row = await findParticipant(this.#database, organizationId, participantId);
    return row === undefined ? notFound() : mapParticipant(row);
  }

  async listParticipants(organizationId: string, input: { limit: number; cursor?: string | undefined;
    training_id?: string | undefined }) {
    const cursor = input.cursor === undefined ? undefined : this.#cursors.decode(input.cursor, organizationId, "participants");
    const rows = await listParticipants(this.#database, { organizationId, limit: input.limit,
      ...(cursor === undefined ? {} : { cursor }), ...(input.training_id === undefined ? {} : { trainingId: input.training_id }) });
    return this.#page(rows, input.limit, organizationId, "participants", mapParticipant);
  }

  async updateParticipant(context: TenantAuthorizationContext, participantId: string, input: UpdateParticipantRequest,
    requestId: string): Promise<Participant> {
    const result = await updateParticipant(this.#database, context.organizationId, participantId, input);
    if (result.conflict) conflict();
    if (result.participant === undefined) return notFound();
    const participant = mapParticipant(result.participant);
    await this.#writeAudit(context, "PARTICIPANT_UPDATED", "participant", participant.id, requestId);
    return participant;
  }

  async queueParticipantImport(context: TenantAuthorizationContext, input: { trainingId: string; idempotencyKey: string;
    filename: string; declaredMimeType: string; bytes: Uint8Array }, requestId: string) {
    if (context.actorMembershipId === null) throw new ApplicationError("FORBIDDEN", "The requested operation is not permitted.", 403);
    const upload = validateParticipantImportUpload(input.filename, input.declaredMimeType, input.bytes);
    const contentSha256 = createHash("sha256").update(input.bytes).digest();
    const requestFingerprint = participantImportRequestFingerprint(
      context.organizationId,
      input.trainingId,
      contentSha256
    );
    const existing = await findParticipantImportByIdempotency(this.#database, context.organizationId, input.idempotencyKey);
    if (existing !== undefined) {
      const existingFingerprint = participantImportRequestFingerprint(
        context.organizationId,
        existing.training_id,
        existing.content_sha256
      );
      if (existingFingerprint !== requestFingerprint) conflict();
      if (existing.status === "FAILED" || existing.status === "DEAD_LETTER" || existing.status === "CANCELLED") conflict();
      return { job_id: existing.id, status: existing.status };
    }
    const jobId = randomUUID();
    const extension = upload.detectedMimeType === "text/csv" ? "csv" : "xlsx";
    const storageKey = `participant-imports/${context.organizationId}/${jobId}/${randomUUID()}.${extension}`;
    await this.#storage.put({ key: storageKey, body: input.bytes, contentType: upload.detectedMimeType,
      contentSha256Hex: contentSha256.toString("hex") });
    let created = false;
    try {
      created = await createParticipantImport(this.#database, {
        jobId, organizationId: context.organizationId, trainingId: input.trainingId, idempotencyKey: input.idempotencyKey,
        requestedByMembershipId: context.actorMembershipId, sourceStorageKey: storageKey,
        originalFilename: upload.originalFilename, contentSha256, detectedMimeType: upload.detectedMimeType,
        sizeBytes: input.bytes.byteLength
      });
      if (!created) return notFound();
    } catch (error) {
      await this.#storage.delete(storageKey).catch(() => undefined);
      if (isUniqueViolation(error)) {
        const duplicate = await findParticipantImportByIdempotency(this.#database, context.organizationId, input.idempotencyKey);
        if (duplicate !== undefined) {
          const duplicateFingerprint = participantImportRequestFingerprint(
            context.organizationId,
            duplicate.training_id,
            duplicate.content_sha256
          );
          if (duplicateFingerprint !== requestFingerprint) conflict();
          if (duplicate.status === "FAILED" || duplicate.status === "DEAD_LETTER" || duplicate.status === "CANCELLED") conflict();
          return { job_id: duplicate.id, status: duplicate.status };
        }
      }
      throw error;
    }
    await this.#writeAudit(context, "PARTICIPANT_IMPORT_QUEUED", "participant_import", jobId, requestId);
    return { job_id: jobId, status: "QUEUED" as const };
  }

  async inspectParticipantImport(organizationId: string, jobId: string,
    input: { limit: number; cursor?: string | undefined }) {
    const cursor = input.cursor === undefined ? undefined
      : this.#cursors.decode(input.cursor, organizationId, "participant_import_rows");
    const result = await inspectParticipantImport(this.#database, organizationId, jobId, input.limit, cursor);
    if (result === undefined) return notFound();
    const pageRows = result.rows.slice(0, input.limit);
    const last = pageRows.at(-1);
    return {
      data: {
        job_id: result.job.id,
        status: result.job.status,
        progress: { completed: result.job.progress_completed, total: result.job.progress_total },
        counts: { valid: result.counts.valid, invalid: result.counts.invalid },
        preview: pageRows.map((row) => ({
          row_number: row.row_number, display_name: row.display_name, external_reference: row.external_reference,
          status: row.status, validation_errors: ImportErrorsSchema.parse(row.validation_errors ?? [])
        }))
      },
      nextCursor: result.rows.length > input.limit && last !== undefined
        ? this.#cursors.encode({ organizationId, resource: "participant_import_rows", createdAt: last.created_at, id: last.id }) : null
    };
  }

  async confirmParticipantImportJob(context: TenantAuthorizationContext, jobId: string, requestId: string) {
    const outcome = await confirmParticipantImport(this.#database, context.organizationId, jobId);
    if (outcome === "NOT_FOUND") return notFound();
    if (outcome === "INVALID_STATE" || outcome === "NO_VALID_ROWS") conflict();
    if (outcome === "CONFIRMED") {
      await this.#writeAudit(context, "PARTICIPANT_IMPORT_CONFIRMED", "participant_import", jobId, requestId);
    }
    const current = await findJob(this.#database, context.organizationId, jobId);
    if (current === undefined) return notFound();
    return { job_id: jobId, status: current.status };
  }

  async getJob(organizationId: string, jobId: string) {
    const job = await findJob(this.#database, organizationId, jobId);
    if (job === undefined) return notFound();
    return { job_id: job.id, type: job.job_type, status: job.status,
      progress: { completed: job.progress_completed, total: job.progress_total },
      attempt_count: job.attempt_count, error_code: job.last_error_code };
  }

  #page<Row extends { id: string; created_at: Date }, Output>(rows: readonly Row[], limit: number, organizationId: string,
    resource: CursorResource, mapper: (row: Row) => Output) {
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return { data: pageRows.map(mapper), nextCursor: rows.length > limit && last !== undefined
      ? this.#cursors.encode({ organizationId, resource, createdAt: last.created_at, id: last.id }) : null };
  }

  async #writeAudit(context: TenantAuthorizationContext, action: AuditAction,
    resourceType: "project" | "training" | "participant" | "participant_import", resourceId: string, requestId: string) {
    await this.#audit.write({ organizationId: context.organizationId, actorUserId: context.actorUserId,
      actorMembershipId: context.actorMembershipId, action, resourceType, resourceId, requestId, metadata: null });
  }
}
