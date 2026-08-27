import {
  AdminOrganizationIdSchema, CreateTemplateRequestSchema, CreateTemplateVersionRequestSchema,
  DeleteDraftVersionResponseSchema, TemplateAssetListResponseSchema, TemplateAssetResponseSchema,
  TemplateChildListQuerySchema, TemplateListQuerySchema, TemplateListResponseSchema, TemplatePreviewResponseSchema, TemplateResponseSchema,
  TemplateVersionListResponseSchema, TemplateVersionResponseSchema, UpdateTemplateRequestSchema,
  UpdateTemplateVersionRequestSchema
} from "@certificate-platform/contracts";
import type { MultipartFile } from "@fastify/multipart";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { ApplicationError } from "../errors/application-error.js";
import type { AuthenticationService } from "../modules/auth/authentication-service.js";
import { readAdminSessionCookie } from "../modules/auth/cookie.js";
import type { OrganizationAuthorizationService, TenantAuthorizationContext } from "../modules/auth/organization-authorization-service.js";
import type { PhaseFourService } from "../modules/phase-four/phase-four-service.js";

const TemplateParamsSchema = z.object({ templateId: z.uuid() }).strict();
const VersionParamsSchema = z.object({ templateId: z.uuid(), versionId: z.uuid() }).strict();
const AssetParamsSchema = z.object({ templateId: z.uuid(), assetId: z.uuid() }).strict();
const noStore = { "cache-control": "no-store" } as const;

export interface AdminPhaseFourRouteOptions {
  readonly authentication: AuthenticationService;
  readonly authorization: OrganizationAuthorizationService;
  readonly service: PhaseFourService;
  readonly templateAssetMaxBytes: number;
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

const authorize = async (request: FastifyRequest, options: AdminPhaseFourRouteOptions, permission: string,
  stateChanging: boolean): Promise<TenantAuthorizationContext> => {
  const authenticated = await authenticate(request, options.authentication);
  const organizationId = parse(AdminOrganizationIdSchema, request.headers["x-organization-id"]);
  return options.authorization.requirePermission({ authenticated, organizationId, permission, requestId: request.id, stateChanging,
    ...(typeof request.headers.origin === "string" ? { origin: request.headers.origin } : {}),
    ...(typeof request.headers["x-csrf-token"] === "string" ? { csrfToken: request.headers["x-csrf-token"] } : {}) });
};

const readAssetFile = async (request: FastifyRequest, maximumBytes: number) => {
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
    if (typeof error === "object" && error !== null && "code" in error && error.code === "FST_REQ_FILE_TOO_LARGE") {
      throw new ApplicationError("UPLOAD_TOO_LARGE", "The uploaded file is too large.", 413);
    }
    throw new ApplicationError("UPLOAD_REJECTED", "The uploaded file could not be accepted.", 400);
  }
  if (file === undefined) return validationFailed();
  return file;
};

export const registerAdminPhaseFourRoutes = (app: FastifyInstance, options: AdminPhaseFourRouteOptions): void => {
  app.post("/api/admin/templates", async (request, reply) => {
    const context = await authorize(request, options, "template:create", true);
    const data = await options.service.createTemplate(context, parse(CreateTemplateRequestSchema, request.body), request.id);
    return reply.status(201).headers(noStore).send(TemplateResponseSchema.parse({ data, meta: { request_id: request.id } }));
  });
  app.get("/api/admin/templates", async (request, reply) => {
    const context = await authorize(request, options, "template:read", false);
    const page = await options.service.listTemplates(context.organizationId, parse(TemplateListQuerySchema, request.query));
    return reply.headers(noStore).send(TemplateListResponseSchema.parse({ data: page.data,
      meta: { request_id: request.id, next_cursor: page.nextCursor } }));
  });
  app.get("/api/admin/templates/:templateId", async (request, reply) => {
    const context = await authorize(request, options, "template:read", false);
    const { templateId } = parse(TemplateParamsSchema, request.params);
    const data = await options.service.getTemplate(context.organizationId, templateId);
    return reply.headers(noStore).send(TemplateResponseSchema.parse({ data, meta: { request_id: request.id } }));
  });
  app.patch("/api/admin/templates/:templateId", async (request, reply) => {
    const context = await authorize(request, options, "template:update", true);
    const { templateId } = parse(TemplateParamsSchema, request.params);
    const data = await options.service.updateTemplate(context, templateId, parse(UpdateTemplateRequestSchema, request.body), request.id);
    return reply.headers(noStore).send(TemplateResponseSchema.parse({ data, meta: { request_id: request.id } }));
  });
  app.post("/api/admin/templates/:templateId/archive", async (request, reply) => {
    const context = await authorize(request, options, "template:update", true);
    const { templateId } = parse(TemplateParamsSchema, request.params);
    const data = await options.service.archiveTemplate(context, templateId, request.id);
    return reply.headers(noStore).send(TemplateResponseSchema.parse({ data, meta: { request_id: request.id } }));
  });

  app.post("/api/admin/templates/:templateId/versions", async (request, reply) => {
    const context = await authorize(request, options, "template:create", true);
    const { templateId } = parse(TemplateParamsSchema, request.params);
    const data = await options.service.createVersion(context, templateId, parse(CreateTemplateVersionRequestSchema, request.body), request.id);
    return reply.status(201).headers(noStore).send(TemplateVersionResponseSchema.parse({ data, meta: { request_id: request.id } }));
  });
  app.get("/api/admin/templates/:templateId/versions", async (request, reply) => {
    const context = await authorize(request, options, "template:read", false);
    const { templateId } = parse(TemplateParamsSchema, request.params);
    const page = await options.service.listVersions(context.organizationId, templateId,
      parse(TemplateChildListQuerySchema, request.query));
    return reply.headers(noStore).send(TemplateVersionListResponseSchema.parse({ data: page.data,
      meta: { request_id: request.id, next_cursor: page.nextCursor } }));
  });
  app.get("/api/admin/templates/:templateId/versions/:versionId", async (request, reply) => {
    const context = await authorize(request, options, "template:read", false);
    const { templateId, versionId } = parse(VersionParamsSchema, request.params);
    const data = await options.service.getVersion(context.organizationId, templateId, versionId);
    return reply.headers(noStore).send(TemplateVersionResponseSchema.parse({ data, meta: { request_id: request.id } }));
  });
  app.patch("/api/admin/templates/:templateId/versions/:versionId", async (request, reply) => {
    const context = await authorize(request, options, "template:update", true);
    const { templateId, versionId } = parse(VersionParamsSchema, request.params);
    const data = await options.service.updateVersion(context, templateId, versionId,
      parse(UpdateTemplateVersionRequestSchema, request.body), request.id);
    return reply.headers(noStore).send(TemplateVersionResponseSchema.parse({ data, meta: { request_id: request.id } }));
  });
  app.delete("/api/admin/templates/:templateId/versions/:versionId", async (request, reply) => {
    const context = await authorize(request, options, "template:update", true);
    const { templateId, versionId } = parse(VersionParamsSchema, request.params);
    const data = await options.service.deleteVersion(context, templateId, versionId, request.id);
    return reply.headers(noStore).send(DeleteDraftVersionResponseSchema.parse({ data, meta: { request_id: request.id } }));
  });
  app.post("/api/admin/templates/:templateId/versions/:versionId/preview", async (request, reply) => {
    const context = await authorize(request, options, "template:read", false);
    const { templateId, versionId } = parse(VersionParamsSchema, request.params);
    const data = await options.service.previewVersion(context.organizationId, templateId, versionId);
    return reply.headers(noStore).send(TemplatePreviewResponseSchema.parse({ data, meta: { request_id: request.id } }));
  });
  app.post("/api/admin/templates/:templateId/versions/:versionId/publish", async (request, reply) => {
    const context = await authorize(request, options, "template:publish", true);
    const { templateId, versionId } = parse(VersionParamsSchema, request.params);
    const data = await options.service.publishVersion(context, templateId, versionId, request.id);
    return reply.headers(noStore).send(TemplateVersionResponseSchema.parse({ data, meta: { request_id: request.id } }));
  });
  app.post("/api/admin/templates/:templateId/versions/:versionId/archive", async (request, reply) => {
    const context = await authorize(request, options, "template:publish", true);
    const { templateId, versionId } = parse(VersionParamsSchema, request.params);
    const data = await options.service.archiveVersion(context, templateId, versionId, request.id);
    return reply.headers(noStore).send(TemplateVersionResponseSchema.parse({ data, meta: { request_id: request.id } }));
  });

  app.post("/api/admin/templates/:templateId/assets", async (request, reply) => {
    const context = await authorize(request, options, "template:asset:create", true);
    const { templateId } = parse(TemplateParamsSchema, request.params);
    const file = await readAssetFile(request, options.templateAssetMaxBytes);
    const data = await options.service.uploadAsset(context, templateId,
      { filename: file.filename, declaredMimeType: file.mimetype, bytes: file.bytes }, request.id);
    return reply.status(201).headers(noStore).send(TemplateAssetResponseSchema.parse({ data, meta: { request_id: request.id } }));
  });
  app.get("/api/admin/templates/:templateId/assets", async (request, reply) => {
    const context = await authorize(request, options, "template:read", false);
    const { templateId } = parse(TemplateParamsSchema, request.params);
    const page = await options.service.listAssets(context.organizationId, templateId,
      parse(TemplateChildListQuerySchema, request.query));
    return reply.headers(noStore).send(TemplateAssetListResponseSchema.parse({ data: page.data,
      meta: { request_id: request.id, next_cursor: page.nextCursor } }));
  });
  app.get("/api/admin/templates/:templateId/assets/:assetId", async (request, reply) => {
    const context = await authorize(request, options, "template:read", false);
    const { templateId, assetId } = parse(AssetParamsSchema, request.params);
    const data = await options.service.getAsset(context.organizationId, templateId, assetId);
    return reply.headers(noStore).send(TemplateAssetResponseSchema.parse({ data, meta: { request_id: request.id } }));
  });
  app.post("/api/admin/templates/:templateId/assets/:assetId/archive", async (request, reply) => {
    const context = await authorize(request, options, "template:asset:create", true);
    const { templateId, assetId } = parse(AssetParamsSchema, request.params);
    const data = await options.service.archiveAsset(context, templateId, assetId, request.id);
    return reply.headers(noStore).send(TemplateAssetResponseSchema.parse({ data, meta: { request_id: request.id } }));
  });
};
