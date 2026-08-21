import { createHash, randomUUID } from "node:crypto";

import type {
  CreateTemplateRequest, CreateTemplateVersionRequest, Template, TemplateAsset, TemplateVersion, UpdateTemplateRequest,
  UpdateTemplateVersionRequest
} from "@certificate-platform/contracts";
import {
  archivePublishedTemplateVersionInTransaction, archiveTemplateAssetInTransaction, archiveTemplateInTransaction,
  createTemplateAssetInTransaction, createTemplateInTransaction, createTemplateVersionInTransaction,
  deleteDraftTemplateVersionInTransaction, findTemplate, findTemplateAsset, findTemplateVersion, listTemplateAssets,
  listTemplates, listTemplateVersions, publishTemplateVersionInTransaction, runAuditedTransaction,
  updateDraftTemplateVersionInTransaction, updateTemplateInTransaction,
  type DatabaseClient, type JsonValue, type NewAuditRecord
} from "@certificate-platform/database";
import type { AuditAction } from "@certificate-platform/domain";
import type { PrivateObjectStorage } from "@certificate-platform/storage";
import {
  TemplateDefinitionSchema, bindTemplate, collectTemplateAssetRequirements, type TemplateDefinition
} from "@certificate-platform/template-engine";

import { ApplicationError } from "../../errors/application-error.js";
import type { TenantAuthorizationContext } from "../auth/organization-authorization-service.js";
import { CursorCodec } from "../phase-three/cursor-codec.js";
import { validateTemplateAssetUpload } from "./template-asset-upload.js";

const notFound = (): never => { throw new ApplicationError("NOT_FOUND", "The requested resource was not found.", 404); };
const conflict = (): never => { throw new ApplicationError("CONFLICT", "The requested operation conflicts with existing data.", 409); };
const validationFailed = (): never => { throw new ApplicationError("VALIDATION_FAILED", "The request could not be processed.", 400); };
const isIntegrityViolation = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error
  && typeof error.code === "string" && ["23503", "23505", "23514", "P0001"].includes(error.code);

const mapTemplate = (row: { id: string; name: string; status: Template["status"] }): Template => ({
  id: row.id, name: row.name, status: row.status
});

const parseDefinition = (value: JsonValue): TemplateDefinition => {
  const result = TemplateDefinitionSchema.safeParse(value);
  return result.success ? result.data : validationFailed();
};

const mapVersion = (row: { id: string; template_id: string; version: number; definition_json: JsonValue;
  asset_ids: readonly string[]; status: TemplateVersion["status"]; published_at: Date | null }): TemplateVersion => ({
  id: row.id, template_id: row.template_id, version: row.version, definition: parseDefinition(row.definition_json),
  asset_ids: [...row.asset_ids], status: row.status, published_at: row.published_at?.toISOString() ?? null
});

const mapAsset = (row: { id: string; template_id: string; original_filename: string; content_sha256: Uint8Array;
  detected_mime_type: string; size_bytes: string; width_px: number | null; height_px: number | null;
  status: TemplateAsset["status"] }): TemplateAsset => ({
  id: row.id, template_id: row.template_id, original_filename: row.original_filename,
  detected_mime_type: row.detected_mime_type as TemplateAsset["detected_mime_type"],
  content_sha256: Buffer.from(row.content_sha256).toString("hex"), size_bytes: Number(row.size_bytes),
  width_px: row.width_px, height_px: row.height_px, status: row.status
});

const previewContext = {
  recipient: { displayName: "Preview Recipient" },
  project: { name: "Preview Project" },
  training: { name: "Preview Training", code: "PREVIEW-001" },
  certificate: { number: "CERT-PREVIEW-001", issuedAt: "2026-01-01" },
  verificationUrl: "https://verify.invalid/#preview-token"
} as const;

export interface PhaseFourServiceOptions {
  readonly database: DatabaseClient;
  readonly storage: PrivateObjectStorage;
  readonly cursorSecret: string;
}

export class PhaseFourService {
  readonly #database: DatabaseClient;
  readonly #storage: PrivateObjectStorage;
  readonly #cursors: CursorCodec;

  constructor(options: PhaseFourServiceOptions) {
    this.#database = options.database;
    this.#storage = options.storage;
    this.#cursors = new CursorCodec(options.cursorSecret);
  }

  async createTemplate(context: TenantAuthorizationContext, input: CreateTemplateRequest, requestId: string): Promise<Template> {
    return runAuditedTransaction(this.#database, async (transaction) => {
      const template = mapTemplate(await createTemplateInTransaction(transaction, context.organizationId, input.name));
      return {
        result: template,
        audit: this.#auditRecord(context, "TEMPLATE_CREATED", "template", template.id, requestId)
      };
    });
  }

  async getTemplate(organizationId: string, templateId: string): Promise<Template> {
    const row = await findTemplate(this.#database, organizationId, templateId);
    return row === undefined ? notFound() : mapTemplate(row);
  }

  async listTemplates(organizationId: string, input: { limit: number; cursor?: string | undefined;
    status?: Template["status"] | undefined }) {
    const cursor = input.cursor === undefined ? undefined : this.#cursors.decode(input.cursor, organizationId, "templates");
    const rows = await listTemplates(this.#database, { organizationId, limit: input.limit,
      ...(cursor === undefined ? {} : { cursor }), ...(input.status === undefined ? {} : { status: input.status }) });
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return { data: page.map(mapTemplate), nextCursor: rows.length > input.limit && last !== undefined
      ? this.#cursors.encode({ organizationId, resource: "templates", createdAt: last.created_at, id: last.id }) : null };
  }

  async updateTemplate(context: TenantAuthorizationContext, templateId: string, input: UpdateTemplateRequest, requestId: string) {
    const template = await runAuditedTransaction(this.#database, async (transaction) => {
      const row = await updateTemplateInTransaction(transaction, context.organizationId, templateId, input.name);
      if (row === undefined) return { result: undefined, audit: null };
      const updated = mapTemplate(row);
      return {
        result: updated,
        audit: this.#auditRecord(context, "TEMPLATE_UPDATED", "template", updated.id, requestId)
      };
    });
    return template === undefined ? notFound() : template;
  }

  async archiveTemplate(context: TenantAuthorizationContext, templateId: string, requestId: string) {
    const template = await runAuditedTransaction(this.#database, async (transaction) => {
      const row = await archiveTemplateInTransaction(transaction, context.organizationId, templateId);
      if (row === undefined) return { result: undefined, audit: null };
      const archived = mapTemplate(row);
      return {
        result: archived,
        audit: this.#auditRecord(context, "TEMPLATE_ARCHIVED", "template", archived.id, requestId)
      };
    });
    return template === undefined ? notFound() : template;
  }

  async createVersion(context: TenantAuthorizationContext, templateId: string, input: CreateTemplateVersionRequest, requestId: string) {
    const assetRequirements = collectTemplateAssetRequirements(input.definition);
    const result = await runAuditedTransaction(this.#database, async (transaction) => {
      const outcome = await createTemplateVersionInTransaction(transaction, {
        organizationId: context.organizationId,
        templateId,
        definition: input.definition as JsonValue,
        assetRequirements
      });
      return {
        result: outcome,
        audit: outcome.outcome === "CREATED"
          ? this.#auditRecord(context, "TEMPLATE_VERSION_CREATED", "template_version", outcome.version.id, requestId)
          : null
      };
    });
    if (result.outcome === "NOT_FOUND") return notFound();
    if (result.outcome === "INVALID_ASSET") return validationFailed();
    const version = await findTemplateVersion(this.#database, context.organizationId, templateId, result.version.id);
    if (version === undefined) return notFound();
    return mapVersion(version);
  }

  async getVersion(organizationId: string, templateId: string, versionId: string) {
    const row = await findTemplateVersion(this.#database, organizationId, templateId, versionId);
    return row === undefined ? notFound() : mapVersion(row);
  }

  async listVersions(organizationId: string, templateId: string) {
    const rows = await listTemplateVersions(this.#database, organizationId, templateId);
    return rows === undefined ? notFound() : rows.map(mapVersion);
  }

  async updateVersion(context: TenantAuthorizationContext, templateId: string, versionId: string,
    input: UpdateTemplateVersionRequest, requestId: string) {
    const outcome = await runAuditedTransaction(this.#database, async (transaction) => {
      const result = await updateDraftTemplateVersionInTransaction(transaction, {
        organizationId: context.organizationId,
        templateId,
        versionId,
        definition: input.definition as JsonValue,
        assetRequirements: collectTemplateAssetRequirements(input.definition)
      });
      return {
        result,
        audit: result === "UPDATED"
          ? this.#auditRecord(context, "TEMPLATE_VERSION_UPDATED", "template_version", versionId, requestId)
          : null
      };
    });
    if (outcome === "NOT_FOUND") return notFound();
    if (outcome === "INVALID_ASSET") return validationFailed();
    return this.getVersion(context.organizationId, templateId, versionId);
  }

  async deleteVersion(context: TenantAuthorizationContext, templateId: string, versionId: string, requestId: string) {
    const deleted = await runAuditedTransaction(this.#database, async (transaction) => {
      const result = await deleteDraftTemplateVersionInTransaction(
        transaction, context.organizationId, templateId, versionId
      );
      return {
        result,
        audit: result
          ? this.#auditRecord(context, "TEMPLATE_VERSION_DELETED", "template_version", versionId, requestId)
          : null
      };
    });
    if (!deleted) return notFound();
    return { deleted: true as const };
  }

  async previewVersion(organizationId: string, templateId: string, versionId: string) {
    const version = await this.getVersion(organizationId, templateId, versionId);
    const assets = await listTemplateAssets(this.#database, organizationId, templateId);
    if (assets === undefined) return notFound();
    const activeIds = new Set(assets.filter((asset) => asset.status === "ACTIVE").map((asset) => asset.id));
    if (version.asset_ids.some((assetId) => !activeIds.has(assetId))) return validationFailed();
    return { definition: version.definition, bound_elements: bindTemplate(version.definition, previewContext) };
  }

  async publishVersion(context: TenantAuthorizationContext, templateId: string, versionId: string, requestId: string) {
    const outcome = await runAuditedTransaction(this.#database, async (transaction) => {
      const result = await publishTemplateVersionInTransaction(transaction, {
        organizationId: context.organizationId,
        templateId,
        versionId,
        validateDefinition: (definition, assets) => {
          const parsed = TemplateDefinitionSchema.safeParse(definition);
          if (!parsed.success) return false;
          const requirements = collectTemplateAssetRequirements(parsed.data);
          return requirements.length === assets.length && requirements.every((requirement, index) => {
            const asset = assets[index];
            if (asset?.id !== requirement.id) return false;
            return requirement.kind === "IMAGE" ? asset.detectedMimeType === "image/png" || asset.detectedMimeType === "image/jpeg"
              : asset.detectedMimeType === "font/ttf" || asset.detectedMimeType === "font/otf";
          });
        }
      });
      return {
        result,
        audit: result === "PUBLISHED"
          ? this.#auditRecord(context, "TEMPLATE_VERSION_PUBLISHED", "template_version", versionId, requestId)
          : null
      };
    });
    if (outcome === "NOT_FOUND") return notFound();
    if (outcome === "INVALID_STATE") return conflict();
    if (outcome === "VALIDATION_FAILED") return validationFailed();
    return this.getVersion(context.organizationId, templateId, versionId);
  }

  async archiveVersion(context: TenantAuthorizationContext, templateId: string, versionId: string, requestId: string) {
    const archived = await runAuditedTransaction(this.#database, async (transaction) => {
      const row = await archivePublishedTemplateVersionInTransaction(
        transaction, context.organizationId, templateId, versionId
      );
      return {
        result: row !== undefined,
        audit: row === undefined
          ? null
          : this.#auditRecord(context, "TEMPLATE_VERSION_ARCHIVED", "template_version", versionId, requestId)
      };
    });
    if (!archived) return conflict();
    return this.getVersion(context.organizationId, templateId, versionId);
  }

  async uploadAsset(context: TenantAuthorizationContext, templateId: string, input: {
    filename: string; declaredMimeType: string; bytes: Uint8Array;
  }, requestId: string): Promise<TemplateAsset> {
    if (context.actorMembershipId === null) throw new ApplicationError("FORBIDDEN", "The requested operation is not permitted.", 403);
    const actorMembershipId = context.actorMembershipId;
    const validated = await validateTemplateAssetUpload(input);
    const id = randomUUID();
    const contentSha256 = createHash("sha256").update(input.bytes).digest();
    const extension = validated.detectedMimeType === "image/png" ? "png" : validated.detectedMimeType === "image/jpeg" ? "jpg"
      : validated.detectedMimeType === "font/ttf" ? "ttf" : "otf";
    const storageKey = `template-assets/${context.organizationId}/${templateId}/${id}/${randomUUID()}.${extension}`;
    await this.#storage.put({ key: storageKey, body: input.bytes, contentType: validated.detectedMimeType,
      contentSha256Hex: contentSha256.toString("hex") });
    try {
      const asset = await runAuditedTransaction(this.#database, async (transaction) => {
        const row = await createTemplateAssetInTransaction(transaction, {
          id, organizationId: context.organizationId, templateId, storageKey,
          originalFilename: validated.originalFilename, contentSha256, detectedMimeType: validated.detectedMimeType,
          sizeBytes: input.bytes.byteLength, widthPx: validated.widthPx, heightPx: validated.heightPx,
          membershipId: actorMembershipId
        });
        if (row === undefined) return { result: undefined, audit: null };
        const created = mapAsset(row);
        return {
          result: created,
          audit: this.#auditRecord(context, "TEMPLATE_ASSET_CREATED", "template_asset", created.id, requestId)
        };
      });
      return asset === undefined ? notFound() : asset;
    } catch (error) {
      await this.#storage.delete(storageKey).catch(() => undefined);
      throw error;
    }
  }

  async listAssets(organizationId: string, templateId: string): Promise<readonly TemplateAsset[]> {
    const rows = await listTemplateAssets(this.#database, organizationId, templateId);
    return rows === undefined ? notFound() : rows.map(mapAsset);
  }

  async archiveAsset(context: TenantAuthorizationContext, templateId: string, assetId: string, requestId: string) {
    try {
      const asset = await runAuditedTransaction(this.#database, async (transaction) => {
        const row = await archiveTemplateAssetInTransaction(transaction, context.organizationId, templateId, assetId);
        if (row === undefined) return { result: undefined, audit: null };
        const archived = mapAsset(row);
        return {
          result: archived,
          audit: this.#auditRecord(context, "TEMPLATE_ASSET_ARCHIVED", "template_asset", archived.id, requestId)
        };
      });
      return asset === undefined ? notFound() : asset;
    } catch (error) {
      if (isIntegrityViolation(error)) return conflict();
      throw error;
    }
  }

  async getAsset(organizationId: string, templateId: string, assetId: string) {
    const row = await findTemplateAsset(this.#database, organizationId, templateId, assetId);
    return row === undefined ? notFound() : mapAsset(row);
  }

  #auditRecord(context: TenantAuthorizationContext, action: AuditAction,
    resourceType: "template" | "template_version" | "template_asset",
    resourceId: string, requestId: string): NewAuditRecord {
    return {
      organizationId: context.organizationId,
      actorUserId: context.actorUserId,
      actorMembershipId: context.actorMembershipId,
      action,
      resourceType,
      resourceId,
      requestId,
      metadata: null
    };
  }

}
