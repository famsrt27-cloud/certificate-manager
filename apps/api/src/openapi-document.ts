import {
  AuthenticationResponseSchema, CreateProjectRequestSchema, CreateTrainingRequestSchema, ErrorResponseSchema,
  JobResponseSchema, LoginRequestSchema, LogoutResponseSchema, ParticipantImportInspectResponseSchema,
  ParticipantImportQueuedResponseSchema, ParticipantListResponseSchema, ParticipantResponseSchema,
  ProjectListResponseSchema, ProjectResponseSchema, TrainingListResponseSchema, TrainingResponseSchema,
  UpdateParticipantRequestSchema, UpdateProjectRequestSchema, UpdateTrainingRequestSchema,
  CreateTemplateRequestSchema, CreateTemplateVersionRequestSchema, DeleteDraftVersionResponseSchema,
  TemplateAssetListResponseSchema, TemplateAssetResponseSchema, TemplateListResponseSchema, TemplatePreviewResponseSchema,
  TemplateResponseSchema, TemplateVersionListResponseSchema, TemplateVersionResponseSchema,
  UpdateTemplateRequestSchema, UpdateTemplateVersionRequestSchema,
  DashboardSummaryResponseSchema, PublicCertificateDownloadRequestSchema, PublicDownloadAuthorizationRequestSchema,
  PublicDownloadAuthorizationResponseSchema, PublicVerificationRequestSchema, PublicVerificationResponseSchema
} from "@certificate-platform/contracts";
import { z } from "zod";

const jsonSchema = (schema: z.ZodType, io: "input" | "output" = "output") =>
  z.toJSONSchema(schema, { io, unrepresentable: "any" });
const jsonRequest = (schema: z.ZodType) => ({ required: true,
  content: { "application/json": { schema: jsonSchema(schema, "input") } } });
const response = (status: number, schema: z.ZodType) => ({ [status]: { description: status < 400 ? "Success" : "Error",
  content: { "application/json": { schema: jsonSchema(schema) } } } });
const adminSecurity = [{ adminSession: [] }];
const stateSecurity = [{ adminSession: [], csrfToken: [] }];
const organizationParameter = { name: "X-Organization-ID", in: "header", required: true,
  description: "Tenant selector verified against the current server-resolved membership.", schema: { type: "string", format: "uuid" } };
const idempotencyParameter = { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 8, maxLength: 200 } };
const pathId = (name: string) => ({ name, in: "path", required: true, schema: { type: "string", format: "uuid" } });
const cursorParameter = { name: "cursor", in: "query", required: false, schema: { type: "string", minLength: 1, maxLength: 2_048 } };
const limitParameter = { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } };
const errors = { ...response(400, ErrorResponseSchema), ...response(401, ErrorResponseSchema), ...response(403, ErrorResponseSchema),
  ...response(404, ErrorResponseSchema), ...response(409, ErrorResponseSchema) };

const readOperation = (permission: string, successSchema: z.ZodType, parameters: object[] = []) => ({
  security: adminSecurity, "x-required-permission": permission, parameters: [organizationParameter, ...parameters],
  responses: { ...response(200, successSchema), ...errors }
});
const writeOperation = (permission: string, successSchema: z.ZodType, parameters: object[] = [], body?: z.ZodType,
  status = 200) => ({
  security: stateSecurity, "x-required-permission": permission, parameters: [organizationParameter, ...parameters],
  ...(body === undefined ? {} : { requestBody: jsonRequest(body) }), responses: { ...response(status, successSchema), ...errors }
});

export const openApiDocument = {
  openapi: "3.1.0",
  info: { title: "Certificate Management & Public Verification Platform", version: "4.0" },
  components: { securitySchemes: {
    adminSession: { type: "apiKey", in: "cookie", name: "__Host-admin_session" },
    csrfToken: { type: "apiKey", in: "header", name: "X-CSRF-Token" }
  } },
  paths: {
    "/health/live": { get: { responses: { "200": { description: "API process is live" } } } },
    "/health/ready": { get: { responses: { "200": { description: "API dependencies are ready" },
      ...response(503, ErrorResponseSchema) } } },
    "/api/admin/auth/login": { post: { security: [], requestBody: jsonRequest(LoginRequestSchema),
      responses: { ...response(200, AuthenticationResponseSchema), ...response(400, ErrorResponseSchema),
        ...response(401, ErrorResponseSchema), ...response(429, ErrorResponseSchema), ...response(503, ErrorResponseSchema) } } },
    "/api/admin/auth/session": { get: { security: adminSecurity,
      responses: { ...response(200, AuthenticationResponseSchema), ...response(401, ErrorResponseSchema) } } },
    "/api/admin/auth/logout": { post: { security: stateSecurity,
      responses: { ...response(200, LogoutResponseSchema), ...response(403, ErrorResponseSchema) } } },
    "/api/admin/dashboard": { get: readOperation("organization:read", DashboardSummaryResponseSchema) },
    "/api/admin/projects": {
      get: readOperation("project:read", ProjectListResponseSchema),
      post: writeOperation("project:create", ProjectResponseSchema, [], CreateProjectRequestSchema, 201)
    },
    "/api/admin/projects/{projectId}": {
      get: readOperation("project:read", ProjectResponseSchema, [pathId("projectId")]),
      patch: writeOperation("project:update", ProjectResponseSchema, [pathId("projectId")], UpdateProjectRequestSchema)
    },
    "/api/admin/projects/{projectId}/archive": {
      post: writeOperation("project:archive", ProjectResponseSchema, [pathId("projectId")])
    },
    "/api/admin/trainings": {
      get: readOperation("training:read", TrainingListResponseSchema),
      post: writeOperation("training:create", TrainingResponseSchema, [], CreateTrainingRequestSchema, 201)
    },
    "/api/admin/trainings/{trainingId}": {
      get: readOperation("training:read", TrainingResponseSchema, [pathId("trainingId")]),
      patch: writeOperation("training:update", TrainingResponseSchema, [pathId("trainingId")], UpdateTrainingRequestSchema)
    },
    "/api/admin/trainings/{trainingId}/archive": {
      post: writeOperation("training:archive", TrainingResponseSchema, [pathId("trainingId")])
    },
    "/api/admin/participants": { get: readOperation("participant:read", ParticipantListResponseSchema) },
    "/api/admin/participants/{participantId}": {
      get: readOperation("participant:read", ParticipantResponseSchema, [pathId("participantId")]),
      patch: writeOperation("participant:update", ParticipantResponseSchema, [pathId("participantId")], UpdateParticipantRequestSchema)
    },
    "/api/admin/trainings/{trainingId}/participants/import": { post: {
      ...writeOperation("participant:import", ParticipantImportQueuedResponseSchema,
        [pathId("trainingId"), idempotencyParameter], undefined, 202),
      requestBody: { required: true, content: { "multipart/form-data": { schema: { type: "object", required: ["file"],
        properties: { file: { type: "string", format: "binary" } }, additionalProperties: false } } } }
    } },
    "/api/admin/participant-imports/{jobId}": {
      get: readOperation("participant:import", ParticipantImportInspectResponseSchema, [pathId("jobId")])
    },
    "/api/admin/participant-imports/{jobId}/confirm": {
      post: writeOperation("participant:import", ParticipantImportQueuedResponseSchema,
        [pathId("jobId"), idempotencyParameter], undefined, 202)
    },
    "/api/admin/jobs/{jobId}": { get: readOperation("job:read", JobResponseSchema, [pathId("jobId")]) },
    "/api/admin/templates": {
      get: readOperation("template:read", TemplateListResponseSchema),
      post: writeOperation("template:create", TemplateResponseSchema, [], CreateTemplateRequestSchema, 201)
    },
    "/api/admin/templates/{templateId}": {
      get: readOperation("template:read", TemplateResponseSchema, [pathId("templateId")]),
      patch: writeOperation("template:update", TemplateResponseSchema, [pathId("templateId")], UpdateTemplateRequestSchema)
    },
    "/api/admin/templates/{templateId}/archive": {
      post: writeOperation("template:update", TemplateResponseSchema, [pathId("templateId")])
    },
    "/api/admin/templates/{templateId}/versions": {
      get: readOperation("template:read", TemplateVersionListResponseSchema, [pathId("templateId"), cursorParameter, limitParameter]),
      post: writeOperation("template:create", TemplateVersionResponseSchema, [pathId("templateId")], CreateTemplateVersionRequestSchema, 201)
    },
    "/api/admin/templates/{templateId}/versions/{versionId}": {
      get: readOperation("template:read", TemplateVersionResponseSchema, [pathId("templateId"), pathId("versionId")]),
      patch: writeOperation("template:update", TemplateVersionResponseSchema, [pathId("templateId"), pathId("versionId")],
        UpdateTemplateVersionRequestSchema),
      delete: writeOperation("template:update", DeleteDraftVersionResponseSchema, [pathId("templateId"), pathId("versionId")])
    },
    "/api/admin/templates/{templateId}/versions/{versionId}/preview": {
      post: readOperation("template:read", TemplatePreviewResponseSchema, [pathId("templateId"), pathId("versionId")])
    },
    "/api/admin/templates/{templateId}/versions/{versionId}/publish": {
      post: writeOperation("template:publish", TemplateVersionResponseSchema, [pathId("templateId"), pathId("versionId")])
    },
    "/api/admin/templates/{templateId}/versions/{versionId}/archive": {
      post: writeOperation("template:publish", TemplateVersionResponseSchema, [pathId("templateId"), pathId("versionId")])
    },
    "/api/admin/templates/{templateId}/assets": {
      get: readOperation("template:read", TemplateAssetListResponseSchema, [pathId("templateId"), cursorParameter, limitParameter]),
      post: {
        ...writeOperation("template:asset:create", TemplateAssetResponseSchema, [pathId("templateId")], undefined, 201),
        requestBody: { required: true, content: { "multipart/form-data": { schema: { type: "object", required: ["file"],
          properties: { file: { type: "string", format: "binary" } }, additionalProperties: false } } } }
      }
    },
    "/api/admin/templates/{templateId}/assets/{assetId}": {
      get: readOperation("template:read", TemplateAssetResponseSchema, [pathId("templateId"), pathId("assetId")])
    },
    "/api/admin/templates/{templateId}/assets/{assetId}/content": {
      get: {
        security: adminSecurity,
        "x-required-permission": "template:read",
        parameters: [organizationParameter, pathId("templateId"), pathId("assetId")],
        responses: {
          "200": { description: "Authenticated active template image", headers: {
            "Cache-Control": { schema: { type: "string" } },
            "X-Content-Type-Options": { schema: { type: "string" } }
          }, content: {
            "image/png": { schema: { type: "string", format: "binary" } },
            "image/jpeg": { schema: { type: "string", format: "binary" } }
          } },
          ...errors
        }
      }
    },
    "/api/admin/templates/{templateId}/assets/{assetId}/archive": {
      post: writeOperation("template:asset:create", TemplateAssetResponseSchema, [pathId("templateId"), pathId("assetId")])
    },
    "/api/public/verify": { post: { security: [], requestBody: jsonRequest(PublicVerificationRequestSchema),
      responses: { ...response(200, PublicVerificationResponseSchema), ...response(400, ErrorResponseSchema),
        ...response(429, ErrorResponseSchema), ...response(500, ErrorResponseSchema) } } },
    "/api/public/certificates/download-authorize": { post: { security: [],
      requestBody: jsonRequest(PublicDownloadAuthorizationRequestSchema),
      responses: { ...response(200, PublicDownloadAuthorizationResponseSchema), ...response(400, ErrorResponseSchema),
        ...response(429, ErrorResponseSchema), ...response(500, ErrorResponseSchema) } } },
    "/api/public/certificates/download": { post: { security: [],
      requestBody: jsonRequest(PublicCertificateDownloadRequestSchema),
      responses: {
        "200": {
          description: "Certificate PDF",
          headers: {
            "Content-Disposition": { schema: { type: "string" }, description: "Static certificate attachment filename" },
            "Cache-Control": { schema: { type: "string" }, description: "private, no-store" },
            "X-Content-Type-Options": { schema: { type: "string" }, description: "nosniff" },
            "X-Request-ID": { schema: { type: "string", format: "uuid" } },
            "X-Robots-Tag": { schema: { type: "string" }, description: "Public endpoint indexing policy" }
          },
          content: { "application/pdf": { schema: { type: "string", format: "binary" } } }
        },
        ...response(400, ErrorResponseSchema), ...response(429, ErrorResponseSchema), ...response(500, ErrorResponseSchema)
      } } }
  }
} as const;
