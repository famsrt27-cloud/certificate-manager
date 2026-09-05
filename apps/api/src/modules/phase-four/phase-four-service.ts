import { createHash, randomUUID } from "node:crypto";

import type {
  CreateTemplateRequest, CreateTemplateVersionRequest, DuplicateTemplateRequest, Template, TemplateAsset, TemplateVersion, UpdateTemplateRequest,
  UpdateTemplateVersionRequest
} from "@certificate-platform/contracts";
import {
  archivePublishedTemplateVersionInTransaction, archiveTemplateAssetInTransaction, archiveTemplateInTransaction,
  armStorageCleanup, cancelRequiredStorageCleanupInTransaction, cancelStorageCleanupInTransaction, completeStorageCleanupByKey,
  createTemplateAssetInTransaction, createTemplateInTransaction, createTemplateVersionInTransaction,
  deleteDraftTemplateVersionInTransaction, findTemplate, findTemplateAsset, findTemplateAssetsByIds,
  findTemplateDuplicationSource, findTemplateImageAssetContent, findTemplateVersion, findTemplateVersionForCloneInTransaction,
  listTemplateAssets, listTemplatePreviewVersions,
  listTemplates, listTemplateVersions, publishTemplateVersionInTransaction, runAuditedTransaction,
  updateDraftTemplateVersionInTransaction, updateTemplateInTransaction,
  type DatabaseClient, type JsonValue, type NewAuditRecord
} from "@certificate-platform/database";
import type { AuditAction } from "@certificate-platform/domain";
import type { PrivateObjectStorage } from "@certificate-platform/storage";
import {
  TemplateDefinitionSchema, bindTemplate, collectTemplateAssetRequirements, remapTemplateAssetIds, type TemplateDefinition
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
    const previews = await listTemplatePreviewVersions(this.#database, organizationId, page.map((row) => row.id));
    const previewByTemplate = new Map(previews.map((row) => [row.template_id, {
      version_id: row.id, version: row.version, status: row.status, definition: parseDefinition(row.definition_json)
    }]));
    const last = page.at(-1);
    return { data: page.map((row) => ({ ...mapTemplate(row), preview: previewByTemplate.get(row.id) ?? null })), nextCursor: rows.length > input.limit && last !== undefined
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

  async cloneVersion(context: TenantAuthorizationContext, templateId: string, sourceVersionId: string, requestId: string) {
    const result = await runAuditedTransaction(this.#database, async (transaction) => {
      const source = await findTemplateVersionForCloneInTransaction(
        transaction, context.organizationId, templateId, sourceVersionId
      );
      if (source === undefined) return { result: { outcome: "NOT_FOUND" as const }, audit: null };
      const definition = parseDefinition(source.definition_json);
      const outcome = await createTemplateVersionInTransaction(transaction, {
        organizationId: context.organizationId,
        templateId,
        definition: definition as JsonValue,
        assetRequirements: collectTemplateAssetRequirements(definition)
      });
      return {
        result: outcome,
        audit: outcome.outcome === "CREATED"
          ? this.#auditRecord(context, "TEMPLATE_VERSION_CLONED", "template_version", outcome.version.id, requestId)
          : null
      };
    });
    if (result.outcome === "NOT_FOUND") return notFound();
    if (result.outcome === "INVALID_ASSET") return validationFailed();
    const version = await findTemplateVersion(this.#database, context.organizationId, templateId, result.version.id);
    if (version === undefined) return notFound();
    return mapVersion(version);
  }

  async duplicateTemplate(context: TenantAuthorizationContext, sourceTemplateId: string, input: DuplicateTemplateRequest,
    maximumBytes: number, requestId: string) {
    if (context.actorMembershipId === null) throw new ApplicationError("FORBIDDEN", "The requested operation is not permitted.", 403);
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) return validationFailed();
    const initial = await findTemplateDuplicationSource(
      this.#database, context.organizationId, sourceTemplateId, input.source_version_id, []
    );
    if (initial === undefined) return notFound();
    const sourceDefinition = parseDefinition(initial.version.definition_json);
    const requirements = collectTemplateAssetRequirements(sourceDefinition);
    const source = await findTemplateDuplicationSource(
      this.#database, context.organizationId, sourceTemplateId, input.source_version_id,
      requirements.map((requirement) => requirement.id)
    );
    if (source === undefined) return notFound();
    if (source.assets.length !== requirements.length) return validationFailed();

    const destinationTemplateId = randomUUID();
    const copiedAssets: Array<{
      sourceId: string; id: string; storageKey: string; originalFilename: string; contentSha256: Buffer;
      detectedMimeType: "image/png" | "image/jpeg" | "font/ttf" | "font/otf";
      sizeBytes: number; widthPx: number | null; heightPx: number | null;
    }> = [];
    const armedKeys: string[] = [];
    const cleanupCopiedObjects = async (): Promise<void> => {
      for (const storageKey of armedKeys) {
        try {
          await this.#storage.delete(storageKey);
          await completeStorageCleanupByKey(this.#database, context.organizationId, storageKey);
        } catch {
          // Keep the pre-armed cleanup intent for reconciliation when deletion is not confirmed.
        }
      }
    };

    try {
      for (let index = 0; index < requirements.length; index += 1) {
        const requirement = requirements[index]!;
        const asset = source.assets[index];
        if (asset === undefined || asset.id !== requirement.id || asset.status !== "ACTIVE") return validationFailed();
        const mimeEligible = requirement.kind === "IMAGE"
          ? asset.detected_mime_type === "image/png" || asset.detected_mime_type === "image/jpeg"
          : asset.detected_mime_type === "font/ttf" || asset.detected_mime_type === "font/otf";
        const expectedSize = Number(asset.size_bytes);
        if (!mimeEligible || !Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > maximumBytes) return validationFailed();
        let bytes: Uint8Array;
        try {
          bytes = await this.#storage.get(asset.storage_key, maximumBytes);
        } catch {
          throw new ApplicationError("SERVICE_UNAVAILABLE", "The service is temporarily unavailable.", 503);
        }
        const contentSha256 = createHash("sha256").update(bytes).digest();
        if (bytes.byteLength !== expectedSize || !contentSha256.equals(Buffer.from(asset.content_sha256))) {
          throw new ApplicationError("SERVICE_UNAVAILABLE", "The service is temporarily unavailable.", 503);
        }
        let validated;
        try {
          validated = await validateTemplateAssetUpload({
            filename: asset.original_filename, declaredMimeType: asset.detected_mime_type, bytes
          });
        } catch {
          return validationFailed();
        }
        if (validated.originalFilename !== asset.original_filename || validated.detectedMimeType !== asset.detected_mime_type
          || validated.widthPx !== asset.width_px
          || validated.heightPx !== asset.height_px) return validationFailed();
        const id = randomUUID();
        const extension = validated.detectedMimeType === "image/png" ? "png" : validated.detectedMimeType === "image/jpeg" ? "jpg"
          : validated.detectedMimeType === "font/ttf" ? "ttf" : "otf";
        const storageKey = `template-assets/${context.organizationId}/${destinationTemplateId}/${id}/${randomUUID()}.${extension}`;
        await armStorageCleanup(this.#database, { organizationId: context.organizationId, objectKey: storageKey,
          notBefore: new Date(Date.now() + 30 * 60 * 1_000) });
        armedKeys.push(storageKey);
        await this.#storage.put({ key: storageKey, body: bytes, contentType: validated.detectedMimeType,
          contentSha256Hex: contentSha256.toString("hex") });
        copiedAssets.push({ sourceId: asset.id, id, storageKey, originalFilename: asset.original_filename,
          contentSha256, detectedMimeType: validated.detectedMimeType, sizeBytes: expectedSize,
          widthPx: validated.widthPx, heightPx: validated.heightPx });
      }

      const assetIdMapping = new Map(copiedAssets.map((asset) => [asset.sourceId, asset.id]));
      const destinationDefinition = remapTemplateAssetIds(sourceDefinition, assetIdMapping);
      const result = await runAuditedTransaction(this.#database, async (transaction) => {
        const current = await findTemplateDuplicationSource(transaction, context.organizationId, sourceTemplateId,
          input.source_version_id, requirements.map((requirement) => requirement.id), true);
        const unchanged = current !== undefined
          && JSON.stringify(parseDefinition(current.version.definition_json)) === JSON.stringify(sourceDefinition)
          && current.assets.length === source.assets.length
          && current.assets.every((asset, index) => {
            const expected = source.assets[index];
            return expected !== undefined && asset.id === expected.id && asset.template_id === expected.template_id
              && asset.storage_key === expected.storage_key && asset.original_filename === expected.original_filename
              && asset.status === expected.status && asset.detected_mime_type === expected.detected_mime_type
              && asset.size_bytes === expected.size_bytes && asset.width_px === expected.width_px && asset.height_px === expected.height_px
              && Buffer.from(asset.content_sha256).equals(Buffer.from(expected.content_sha256));
          });
        if (!unchanged) return { result: undefined, audit: null };
        const templateRow = await createTemplateInTransaction(transaction, context.organizationId, input.name, destinationTemplateId);
        for (const asset of copiedAssets) {
          const created = await createTemplateAssetInTransaction(transaction, {
            id: asset.id, organizationId: context.organizationId, templateId: destinationTemplateId,
            storageKey: asset.storageKey, originalFilename: asset.originalFilename, contentSha256: asset.contentSha256,
            detectedMimeType: asset.detectedMimeType, sizeBytes: asset.sizeBytes, widthPx: asset.widthPx,
            heightPx: asset.heightPx, membershipId: context.actorMembershipId!
          });
          if (created === undefined) throw new Error("Destination template asset creation failed");
        }
        const versionOutcome = await createTemplateVersionInTransaction(transaction, {
          organizationId: context.organizationId, templateId: destinationTemplateId,
          definition: destinationDefinition as JsonValue,
          assetRequirements: collectTemplateAssetRequirements(destinationDefinition)
        });
        if (versionOutcome.outcome !== "CREATED" || versionOutcome.version.version !== 1) {
          throw new Error("Destination template version creation failed");
        }
        for (const storageKey of armedKeys) {
          if (!await cancelRequiredStorageCleanupInTransaction(transaction, context.organizationId, storageKey)) {
            throw new Error("Destination template asset cleanup intent was already claimed");
          }
        }
        return {
          result: {
            template: mapTemplate(templateRow),
            version: mapVersion({ ...versionOutcome.version, asset_ids: copiedAssets.map((asset) => asset.id).sort() })
          },
          audit: this.#auditRecord(context, "TEMPLATE_DUPLICATED", "template", destinationTemplateId, requestId)
        };
      });
      if (result === undefined) {
        await cleanupCopiedObjects();
        return conflict();
      }
      return result;
    } catch (error) {
      await cleanupCopiedObjects();
      if (isIntegrityViolation(error)) return conflict();
      throw error;
    }
  }

  async getVersion(organizationId: string, templateId: string, versionId: string) {
    const row = await findTemplateVersion(this.#database, organizationId, templateId, versionId);
    return row === undefined ? notFound() : mapVersion(row);
  }

  async listVersions(organizationId: string, templateId: string, input: { limit: number; cursor?: string | undefined }) {
    const cursor = input.cursor === undefined ? undefined : this.#cursors.decode(input.cursor, organizationId, "template_versions");
    const rows = await listTemplateVersions(this.#database, { organizationId, templateId, limit: input.limit,
      ...(cursor === undefined ? {} : { cursor }) });
    if (rows === undefined) return notFound();
    const data = rows.slice(0, input.limit);
    const last = data.at(-1);
    return { data: data.map(mapVersion), nextCursor: rows.length > input.limit && last !== undefined
      ? this.#cursors.encode({ organizationId, resource: "template_versions", createdAt: last.created_at, id: last.id }) : null };
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
    const assets = await findTemplateAssetsByIds(this.#database, organizationId, templateId, version.asset_ids);
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
    await armStorageCleanup(this.#database, {
      organizationId: context.organizationId,
      objectKey: storageKey,
      notBefore: new Date(Date.now() + 30 * 60 * 1_000)
    });
    try {
      await this.#storage.put({ key: storageKey, body: input.bytes, contentType: validated.detectedMimeType,
        contentSha256Hex: contentSha256.toString("hex") });
      const asset = await runAuditedTransaction(this.#database, async (transaction) => {
        const row = await createTemplateAssetInTransaction(transaction, {
          id, organizationId: context.organizationId, templateId, storageKey,
          originalFilename: validated.originalFilename, contentSha256, detectedMimeType: validated.detectedMimeType,
          sizeBytes: input.bytes.byteLength, widthPx: validated.widthPx, heightPx: validated.heightPx,
          membershipId: actorMembershipId
        });
        if (row === undefined) return { result: undefined, audit: null };
        await cancelStorageCleanupInTransaction(transaction, context.organizationId, storageKey);
        const created = mapAsset(row);
        return {
          result: created,
          audit: this.#auditRecord(context, "TEMPLATE_ASSET_CREATED", "template_asset", created.id, requestId)
        };
      });
      return asset === undefined ? notFound() : asset;
    } catch (error) {
      try {
        await this.#storage.delete(storageKey);
        await completeStorageCleanupByKey(this.#database, context.organizationId, storageKey);
      } catch {
        // The pre-armed cleanup intent remains durable for the worker reconciler.
      }
      throw error;
    }
  }

  async listAssets(organizationId: string, templateId: string, input: { limit: number; cursor?: string | undefined }) {
    const cursor = input.cursor === undefined ? undefined : this.#cursors.decode(input.cursor, organizationId, "template_assets");
    const rows = await listTemplateAssets(this.#database, { organizationId, templateId, limit: input.limit,
      ...(cursor === undefined ? {} : { cursor }) });
    if (rows === undefined) return notFound();
    const data = rows.slice(0, input.limit);
    const last = data.at(-1);
    return { data: data.map(mapAsset), nextCursor: rows.length > input.limit && last !== undefined
      ? this.#cursors.encode({ organizationId, resource: "template_assets", createdAt: last.created_at, id: last.id }) : null };
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

  async getActiveImageContent(organizationId: string, templateId: string, assetId: string, maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) return validationFailed();
    const row = await findTemplateImageAssetContent(this.#database, organizationId, templateId, assetId);
    if (row === undefined || row.status !== "ACTIVE"
      || (row.detected_mime_type !== "image/png" && row.detected_mime_type !== "image/jpeg")) return notFound();
    const expectedSize = Number(row.size_bytes);
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > maximumBytes) return validationFailed();
    let bytes: Uint8Array;
    try {
      bytes = await this.#storage.get(row.storage_key, maximumBytes);
    } catch {
      throw new ApplicationError("SERVICE_UNAVAILABLE", "The service is temporarily unavailable.", 503);
    }
    const actualHash = createHash("sha256").update(bytes).digest();
    if (bytes.byteLength !== expectedSize || !actualHash.equals(Buffer.from(row.content_sha256))) {
      throw new ApplicationError("SERVICE_UNAVAILABLE", "The service is temporarily unavailable.", 503);
    }
    return { bytes, mimeType: row.detected_mime_type } as const;
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
