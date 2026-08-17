import {
  AdminOrganizationIdSchema, CreateProjectRequestSchema, CreateTrainingRequestSchema, IdempotencyKeySchema,
  JobResponseSchema, ParticipantImportInspectQuerySchema, ParticipantImportInspectResponseSchema,
  ParticipantImportQueuedResponseSchema, ParticipantListQuerySchema, ParticipantListResponseSchema,
  ParticipantResponseSchema, ProjectListQuerySchema, ProjectListResponseSchema, ProjectResponseSchema,
  TrainingListQuerySchema, TrainingListResponseSchema, TrainingResponseSchema, UpdateParticipantRequestSchema,
  UpdateProjectRequestSchema, UpdateTrainingRequestSchema
} from "@certificate-platform/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { MultipartFile } from "@fastify/multipart";
import { z } from "zod";

import { ApplicationError } from "../errors/application-error.js";
import type { OrganizationAuthorizationService, TenantAuthorizationContext } from "../modules/auth/organization-authorization-service.js";
import type { AuthenticationService } from "../modules/auth/authentication-service.js";
import { readAdminSessionCookie } from "../modules/auth/cookie.js";
import type { PhaseThreeService } from "../modules/phase-three/phase-three-service.js";

const ProjectParamsSchema = z.object({ projectId: z.uuid() }).strict();
const TrainingParamsSchema = z.object({ trainingId: z.uuid() }).strict();
const ParticipantParamsSchema = z.object({ participantId: z.uuid() }).strict();
const JobParamsSchema = z.object({ jobId: z.uuid() }).strict();
const noStore = { "cache-control": "no-store" } as const;

export interface AdminPhaseThreeRouteOptions {
  readonly authentication: AuthenticationService;
  readonly authorization: OrganizationAuthorizationService;
  readonly service: PhaseThreeService;
  readonly participantImportMaxBytes: number;
}

const validationFailed = (): never => {
  throw new ApplicationError("VALIDATION_FAILED", "The request could not be processed.", 400);
};

const parse = <Output>(schema: z.ZodType<Output>, input: unknown): Output => {
  const result = schema.safeParse(input);
  return result.success ? result.data : validationFailed();
};

const authenticate = async (request: FastifyRequest, service: AuthenticationService) => {
  try {
    const context = await service.authenticate(readAdminSessionCookie(request.headers.cookie), request.id);
    if (context === null) throw new ApplicationError("AUTHENTICATION_REQUIRED", "Authentication is required.", 401);
    return context;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    request.log.error({ error_code: "AUTH_STATE_UNAVAILABLE" }, "authentication state unavailable");
    throw new ApplicationError("SERVICE_UNAVAILABLE", "The service is temporarily unavailable.", 503);
  }
};

const authorize = async (request: FastifyRequest, options: AdminPhaseThreeRouteOptions, permission: string,
  stateChanging: boolean): Promise<TenantAuthorizationContext> => {
  const authenticated = await authenticate(request, options.authentication);
  const organizationId = parse(AdminOrganizationIdSchema, request.headers["x-organization-id"]);
  return options.authorization.requirePermission({
    authenticated, organizationId, permission, requestId: request.id, stateChanging,
    ...(typeof request.headers.origin === "string" ? { origin: request.headers.origin } : {}),
    ...(typeof request.headers["x-csrf-token"] === "string" ? { csrfToken: request.headers["x-csrf-token"] } : {})
  });
};

const readImportFile = async (request: FastifyRequest, maximumBytes: number) => {
  let file: { filename: string; mimetype: string; bytes: Buffer } | undefined;
  try {
    for await (const part of request.parts()) {
      if (part.type !== "file") validationFailed();
      const filePart = part as MultipartFile;
      if (filePart.fieldname !== "file" || file !== undefined) { filePart.file.resume(); validationFailed(); }
      const bytes = await filePart.toBuffer();
      if (bytes.byteLength > maximumBytes) throw new ApplicationError("UPLOAD_TOO_LARGE", "The uploaded file is too large.", 413);
      file = { filename: filePart.filename, mimetype: filePart.mimetype, bytes };
    }
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError("UPLOAD_REJECTED", "The uploaded file could not be accepted.", 400);
  }
  if (file === undefined) return validationFailed();
  return file;
};

export const registerAdminPhaseThreeRoutes = (app: FastifyInstance, options: AdminPhaseThreeRouteOptions): void => {
  app.post("/api/admin/projects", async (request, reply) => {
    const context = await authorize(request, options, "project:create", true);
    const project = await options.service.createProject(context, parse(CreateProjectRequestSchema, request.body), request.id);
    return reply.status(201).headers(noStore).send(ProjectResponseSchema.parse({ data: project, meta: { request_id: request.id } }));
  });
  app.get("/api/admin/projects", async (request, reply) => {
    const context = await authorize(request, options, "project:read", false);
    const page = await options.service.listProjects(context.organizationId, parse(ProjectListQuerySchema, request.query));
    return reply.headers(noStore).send(ProjectListResponseSchema.parse({ data: page.data,
      meta: { request_id: request.id, next_cursor: page.nextCursor } }));
  });
  app.get("/api/admin/projects/:projectId", async (request, reply) => {
    const context = await authorize(request, options, "project:read", false);
    const { projectId } = parse(ProjectParamsSchema, request.params);
    return reply.headers(noStore).send(ProjectResponseSchema.parse({
      data: await options.service.getProject(context.organizationId, projectId), meta: { request_id: request.id }
    }));
  });
  app.patch("/api/admin/projects/:projectId", async (request, reply) => {
    const context = await authorize(request, options, "project:update", true);
    const { projectId } = parse(ProjectParamsSchema, request.params);
    return reply.headers(noStore).send(ProjectResponseSchema.parse({
      data: await options.service.updateProject(context, projectId, parse(UpdateProjectRequestSchema, request.body), request.id),
      meta: { request_id: request.id }
    }));
  });
  app.post("/api/admin/projects/:projectId/archive", async (request, reply) => {
    const context = await authorize(request, options, "project:archive", true);
    const { projectId } = parse(ProjectParamsSchema, request.params);
    return reply.headers(noStore).send(ProjectResponseSchema.parse({
      data: await options.service.archiveProject(context, projectId, request.id), meta: { request_id: request.id }
    }));
  });

  app.post("/api/admin/trainings", async (request, reply) => {
    const context = await authorize(request, options, "training:create", true);
    const training = await options.service.createTraining(context, parse(CreateTrainingRequestSchema, request.body), request.id);
    return reply.status(201).headers(noStore).send(TrainingResponseSchema.parse({ data: training, meta: { request_id: request.id } }));
  });
  app.get("/api/admin/trainings", async (request, reply) => {
    const context = await authorize(request, options, "training:read", false);
    const page = await options.service.listTrainings(context.organizationId, parse(TrainingListQuerySchema, request.query));
    return reply.headers(noStore).send(TrainingListResponseSchema.parse({ data: page.data,
      meta: { request_id: request.id, next_cursor: page.nextCursor } }));
  });
  app.get("/api/admin/trainings/:trainingId", async (request, reply) => {
    const context = await authorize(request, options, "training:read", false);
    const { trainingId } = parse(TrainingParamsSchema, request.params);
    return reply.headers(noStore).send(TrainingResponseSchema.parse({
      data: await options.service.getTraining(context.organizationId, trainingId), meta: { request_id: request.id }
    }));
  });
  app.patch("/api/admin/trainings/:trainingId", async (request, reply) => {
    const context = await authorize(request, options, "training:update", true);
    const { trainingId } = parse(TrainingParamsSchema, request.params);
    return reply.headers(noStore).send(TrainingResponseSchema.parse({
      data: await options.service.updateTraining(context, trainingId, parse(UpdateTrainingRequestSchema, request.body), request.id),
      meta: { request_id: request.id }
    }));
  });
  app.post("/api/admin/trainings/:trainingId/archive", async (request, reply) => {
    const context = await authorize(request, options, "training:archive", true);
    const { trainingId } = parse(TrainingParamsSchema, request.params);
    return reply.headers(noStore).send(TrainingResponseSchema.parse({
      data: await options.service.archiveTraining(context, trainingId, request.id), meta: { request_id: request.id }
    }));
  });

  app.get("/api/admin/participants", async (request, reply) => {
    const context = await authorize(request, options, "participant:read", false);
    const page = await options.service.listParticipants(context.organizationId, parse(ParticipantListQuerySchema, request.query));
    return reply.headers(noStore).send(ParticipantListResponseSchema.parse({ data: page.data,
      meta: { request_id: request.id, next_cursor: page.nextCursor } }));
  });
  app.get("/api/admin/participants/:participantId", async (request, reply) => {
    const context = await authorize(request, options, "participant:read", false);
    const { participantId } = parse(ParticipantParamsSchema, request.params);
    return reply.headers(noStore).send(ParticipantResponseSchema.parse({
      data: await options.service.getParticipant(context.organizationId, participantId), meta: { request_id: request.id }
    }));
  });
  app.patch("/api/admin/participants/:participantId", async (request, reply) => {
    const context = await authorize(request, options, "participant:update", true);
    const { participantId } = parse(ParticipantParamsSchema, request.params);
    return reply.headers(noStore).send(ParticipantResponseSchema.parse({
      data: await options.service.updateParticipant(context, participantId,
        parse(UpdateParticipantRequestSchema, request.body), request.id), meta: { request_id: request.id }
    }));
  });

  app.post("/api/admin/trainings/:trainingId/participants/import", async (request, reply) => {
    const context = await authorize(request, options, "participant:import", true);
    const { trainingId } = parse(TrainingParamsSchema, request.params);
    const idempotencyKey = parse(IdempotencyKeySchema, request.headers["idempotency-key"]);
    const file = await readImportFile(request, options.participantImportMaxBytes);
    const result = await options.service.queueParticipantImport(context, { trainingId, idempotencyKey,
      filename: file.filename, declaredMimeType: file.mimetype, bytes: file.bytes }, request.id);
    return reply.status(202).headers(noStore).send(ParticipantImportQueuedResponseSchema.parse({
      data: result, meta: { request_id: request.id }
    }));
  });
  app.get("/api/admin/participant-imports/:jobId", async (request, reply) => {
    const context = await authorize(request, options, "participant:import", false);
    const { jobId } = parse(JobParamsSchema, request.params);
    const result = await options.service.inspectParticipantImport(context.organizationId, jobId,
      parse(ParticipantImportInspectQuerySchema, request.query));
    return reply.headers(noStore).send(ParticipantImportInspectResponseSchema.parse({ data: result.data,
      meta: { request_id: request.id, next_cursor: result.nextCursor } }));
  });
  app.post("/api/admin/participant-imports/:jobId/confirm", async (request, reply) => {
    const context = await authorize(request, options, "participant:import", true);
    const { jobId } = parse(JobParamsSchema, request.params);
    parse(IdempotencyKeySchema, request.headers["idempotency-key"]);
    const result = await options.service.confirmParticipantImportJob(context, jobId, request.id);
    return reply.status(202).headers(noStore).send(ParticipantImportQueuedResponseSchema.parse({
      data: result, meta: { request_id: request.id }
    }));
  });
  app.get("/api/admin/jobs/:jobId", async (request, reply) => {
    const context = await authorize(request, options, "job:read", false);
    const { jobId } = parse(JobParamsSchema, request.params);
    return reply.headers(noStore).send(JobResponseSchema.parse({
      data: await options.service.getJob(context.organizationId, jobId), meta: { request_id: request.id }
    }));
  });
};
