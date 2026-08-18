import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";

import type { Database, JsonValue, RecordStatus } from "./types.js";
import type { ResourceCursor } from "./phase-three-repository.js";

export interface TemplateListInput {
  readonly organizationId: string;
  readonly limit: number;
  readonly cursor?: ResourceCursor;
  readonly status?: RecordStatus;
}

export const createTemplate = async (database: Kysely<Database>, organizationId: string, name: string) =>
  database.insertInto("certificate_templates").values({ organization_id: organizationId, name })
    .returning(["id", "name", "status", "created_at"]).executeTakeFirstOrThrow();

export const findTemplate = async (database: Kysely<Database>, organizationId: string, templateId: string) =>
  database.selectFrom("certificate_templates").select(["id", "name", "status", "created_at"])
    .where("organization_id", "=", organizationId).where("id", "=", templateId).executeTakeFirst();

export const listTemplates = async (database: Kysely<Database>, input: TemplateListInput) => {
  let query = database.selectFrom("certificate_templates").select(["id", "name", "status", "created_at"])
    .where("organization_id", "=", input.organizationId);
  if (input.status !== undefined) query = query.where("status", "=", input.status);
  if (input.cursor !== undefined) query = query.where((expression) => expression.or([
    expression("created_at", "<", input.cursor!.createdAt),
    expression.and([expression("created_at", "=", input.cursor!.createdAt), expression("id", "<", input.cursor!.id)])
  ]));
  return query.orderBy("created_at", "desc").orderBy("id", "desc").limit(input.limit + 1).execute();
};

export const updateTemplate = async (database: Kysely<Database>, organizationId: string, templateId: string, name: string) =>
  database.updateTable("certificate_templates").set({ name, updated_at: new Date() })
    .where("organization_id", "=", organizationId).where("id", "=", templateId).where("status", "!=", "ARCHIVED")
    .returning(["id", "name", "status", "created_at"]).executeTakeFirst();

export const archiveTemplate = async (database: Kysely<Database>, organizationId: string, templateId: string) =>
  database.updateTable("certificate_templates").set({ status: "ARCHIVED", updated_at: new Date() })
    .where("organization_id", "=", organizationId).where("id", "=", templateId)
    .returning(["id", "name", "status", "created_at"]).executeTakeFirst();

const replaceVersionAssets = async (transaction: Transaction<Database>, input: {
  organizationId: string; templateId: string; versionId: string;
  assetRequirements: readonly { readonly id: string; readonly kind: "IMAGE" | "FONT" }[];
}): Promise<boolean> => {
  const assetIds = input.assetRequirements.map((requirement) => requirement.id);
  if (assetIds.length > 0) {
    const assets = await transaction.selectFrom("template_assets").select(["id", "detected_mime_type"])
      .where("organization_id", "=", input.organizationId).where("template_id", "=", input.templateId)
      .where("id", "in", assetIds).where("status", "=", "ACTIVE").execute();
    if (assets.length !== assetIds.length || input.assetRequirements.some((requirement) => {
      const mimeType = assets.find((asset) => asset.id === requirement.id)?.detected_mime_type;
      return requirement.kind === "IMAGE" ? mimeType !== "image/png" && mimeType !== "image/jpeg"
        : mimeType !== "font/ttf" && mimeType !== "font/otf";
    })) return false;
  }
  await transaction.deleteFrom("template_version_assets").where("organization_id", "=", input.organizationId)
    .where("template_id", "=", input.templateId).where("template_version_id", "=", input.versionId).execute();
  if (assetIds.length > 0) await transaction.insertInto("template_version_assets").values(assetIds.map((assetId) => ({
    organization_id: input.organizationId, template_id: input.templateId,
    template_version_id: input.versionId, asset_id: assetId
  }))).execute();
  return true;
};

export const createTemplateVersion = async (database: Kysely<Database>, input: {
  organizationId: string; templateId: string; definition: JsonValue;
  assetRequirements: readonly { readonly id: string; readonly kind: "IMAGE" | "FONT" }[];
}) => database.transaction().execute(async (transaction) => {
  await sql`select pg_advisory_xact_lock(hashtextextended(${input.templateId}, 0))`.execute(transaction);
  const template = await transaction.selectFrom("certificate_templates").select("id")
    .where("organization_id", "=", input.organizationId).where("id", "=", input.templateId)
    .where("status", "=", "ACTIVE").executeTakeFirst();
  if (template === undefined) return { outcome: "NOT_FOUND" as const };
  const latest = await transaction.selectFrom("template_versions").select(sql<number>`coalesce(max(version), 0)::int`.as("version"))
    .where("organization_id", "=", input.organizationId).where("template_id", "=", input.templateId).executeTakeFirstOrThrow();
  const version = await transaction.insertInto("template_versions").values({ organization_id: input.organizationId,
    template_id: input.templateId, version: latest.version + 1, definition_json: input.definition })
    .returning(["id", "template_id", "version", "definition_json", "status", "published_at", "created_at"]).executeTakeFirstOrThrow();
  if (!await replaceVersionAssets(transaction, { ...input, versionId: version.id })) return { outcome: "INVALID_ASSET" as const };
  return { outcome: "CREATED" as const, version };
});

export const findTemplateVersion = async (database: Kysely<Database>, organizationId: string, templateId: string, versionId: string) => {
  const version = await database.selectFrom("template_versions").select([
    "id", "template_id", "version", "definition_json", "status", "published_at", "created_at"
  ]).where("organization_id", "=", organizationId).where("template_id", "=", templateId).where("id", "=", versionId).executeTakeFirst();
  if (version === undefined) return undefined;
  const assets = await database.selectFrom("template_version_assets").select("asset_id")
    .where("organization_id", "=", organizationId).where("template_id", "=", templateId)
    .where("template_version_id", "=", versionId).orderBy("asset_id").execute();
  return { ...version, asset_ids: assets.map((asset) => asset.asset_id) };
};

export const listTemplateVersions = async (database: Kysely<Database>, organizationId: string, templateId: string) => {
  const template = await findTemplate(database, organizationId, templateId);
  if (template === undefined) return undefined;
  const versions = await database.selectFrom("template_versions").select([
    "id", "template_id", "version", "definition_json", "status", "published_at", "created_at"
  ]).where("organization_id", "=", organizationId).where("template_id", "=", templateId).orderBy("version", "desc").execute();
  const links = versions.length === 0 ? [] : await database.selectFrom("template_version_assets").select(["template_version_id", "asset_id"])
    .where("organization_id", "=", organizationId).where("template_id", "=", templateId)
    .where("template_version_id", "in", versions.map((version) => version.id)).orderBy("asset_id").execute();
  return versions.map((version) => ({ ...version,
    asset_ids: links.filter((link) => link.template_version_id === version.id).map((link) => link.asset_id) }));
};

export const updateDraftTemplateVersion = async (database: Kysely<Database>, input: {
  organizationId: string; templateId: string; versionId: string; definition: JsonValue;
  assetRequirements: readonly { readonly id: string; readonly kind: "IMAGE" | "FONT" }[];
}) => database.transaction().execute(async (transaction) => {
  const version = await transaction.selectFrom("template_versions").select("id")
    .where("organization_id", "=", input.organizationId).where("template_id", "=", input.templateId)
    .where("id", "=", input.versionId).where("status", "=", "DRAFT").forUpdate().executeTakeFirst();
  if (version === undefined) return "NOT_FOUND" as const;
  if (!await replaceVersionAssets(transaction, { ...input, versionId: input.versionId })) return "INVALID_ASSET" as const;
  await transaction.updateTable("template_versions").set({ definition_json: input.definition })
    .where("organization_id", "=", input.organizationId).where("id", "=", input.versionId).execute();
  return "UPDATED" as const;
});

export const deleteDraftTemplateVersion = async (database: Kysely<Database>, organizationId: string, templateId: string, versionId: string) =>
  database.transaction().execute(async (transaction) => {
    const version = await transaction.selectFrom("template_versions").select("id")
      .where("organization_id", "=", organizationId).where("template_id", "=", templateId)
      .where("id", "=", versionId).where("status", "=", "DRAFT").forUpdate().executeTakeFirst();
    if (version === undefined) return false;
    await transaction.deleteFrom("template_version_assets").where("organization_id", "=", organizationId)
      .where("template_version_id", "=", versionId).execute();
    await transaction.deleteFrom("template_versions").where("organization_id", "=", organizationId).where("id", "=", versionId).execute();
    return true;
  });

export const publishTemplateVersion = async (database: Kysely<Database>, input: {
  organizationId: string; templateId: string; versionId: string;
  validateDefinition: (definition: JsonValue, assets: readonly { readonly id: string; readonly detectedMimeType: string }[]) => boolean;
}) => database.transaction().execute(async (transaction) => {
  const version = await transaction.selectFrom("template_versions as version")
    .innerJoin("certificate_templates as template", (join) => join.onRef("template.id", "=", "version.template_id")
      .onRef("template.organization_id", "=", "version.organization_id"))
    .select(["version.definition_json", "version.status", "template.status as template_status"])
    .where("version.organization_id", "=", input.organizationId).where("version.template_id", "=", input.templateId)
    .where("version.id", "=", input.versionId).forUpdate().executeTakeFirst();
  if (version === undefined) return "NOT_FOUND" as const;
  if (version.status !== "DRAFT" || version.template_status !== "ACTIVE") return "INVALID_STATE" as const;
  const links = await transaction.selectFrom("template_version_assets as link")
    .innerJoin("template_assets as asset", (join) => join.onRef("asset.id", "=", "link.asset_id")
      .onRef("asset.organization_id", "=", "link.organization_id").onRef("asset.template_id", "=", "link.template_id"))
    .select(["link.asset_id", "asset.status", "asset.detected_mime_type"]).where("link.organization_id", "=", input.organizationId)
    .where("link.template_id", "=", input.templateId).where("link.template_version_id", "=", input.versionId).execute();
  const assets = links.map((link) => ({ id: link.asset_id, detectedMimeType: link.detected_mime_type }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (links.some((link) => link.status !== "ACTIVE") || !input.validateDefinition(version.definition_json, assets)) {
    return "VALIDATION_FAILED" as const;
  }
  await transaction.updateTable("template_versions").set({ status: "PUBLISHED", published_at: new Date() })
    .where("organization_id", "=", input.organizationId).where("id", "=", input.versionId).execute();
  return "PUBLISHED" as const;
});

export const archivePublishedTemplateVersion = async (database: Kysely<Database>, organizationId: string,
  templateId: string, versionId: string) => database.updateTable("template_versions")
  .set({ status: "ARCHIVED" }).where("organization_id", "=", organizationId).where("template_id", "=", templateId)
  .where("id", "=", versionId).where("status", "=", "PUBLISHED")
  .returning(["id", "template_id", "version", "definition_json", "status", "published_at", "created_at"]).executeTakeFirst();

export const createTemplateAsset = async (database: Kysely<Database>, input: {
  id: string; organizationId: string; templateId: string; storageKey: string; originalFilename: string;
  contentSha256: Uint8Array; detectedMimeType: string; sizeBytes: number; widthPx: number | null; heightPx: number | null;
  membershipId: string;
}) => database.insertInto("template_assets").columns([
  "id", "organization_id", "template_id", "storage_key", "original_filename", "content_sha256", "detected_mime_type",
  "size_bytes", "width_px", "height_px", "status", "created_by_membership_id"
]).expression((expression) => expression.selectFrom("certificate_templates").select([
  expression.val(input.id).as("id"), expression.val(input.organizationId).as("organization_id"), "id as template_id",
  expression.val(input.storageKey).as("storage_key"), expression.val(input.originalFilename).as("original_filename"),
  expression.val(input.contentSha256).as("content_sha256"), expression.val(input.detectedMimeType).as("detected_mime_type"),
  expression.val(String(input.sizeBytes)).as("size_bytes"), expression.val(input.widthPx).as("width_px"),
  expression.val(input.heightPx).as("height_px"), expression.val("ACTIVE" as const).as("status"),
  expression.val(input.membershipId).as("created_by_membership_id")
]).where("organization_id", "=", input.organizationId).where("id", "=", input.templateId).where("status", "=", "ACTIVE"))
  .returning(["id", "template_id", "original_filename", "content_sha256", "detected_mime_type", "size_bytes", "width_px", "height_px", "status"])
  .executeTakeFirst();

export const findTemplateAsset = async (database: Kysely<Database>, organizationId: string, templateId: string, assetId: string) =>
  database.selectFrom("template_assets").select([
    "id", "template_id", "original_filename", "content_sha256", "detected_mime_type", "size_bytes", "width_px", "height_px", "status"
  ]).where("organization_id", "=", organizationId).where("template_id", "=", templateId).where("id", "=", assetId).executeTakeFirst();

export const listTemplateAssets = async (database: Kysely<Database>, organizationId: string, templateId: string) => {
  const template = await findTemplate(database, organizationId, templateId);
  if (template === undefined) return undefined;
  return database.selectFrom("template_assets").select([
    "id", "template_id", "original_filename", "content_sha256", "detected_mime_type", "size_bytes", "width_px", "height_px", "status"
  ]).where("organization_id", "=", organizationId).where("template_id", "=", templateId).orderBy("created_at", "desc").execute();
};

export const archiveTemplateAsset = async (database: Kysely<Database>, organizationId: string, templateId: string, assetId: string) =>
  database.updateTable("template_assets").set({ status: "ARCHIVED" }).where("organization_id", "=", organizationId)
    .where("template_id", "=", templateId).where("id", "=", assetId).where("status", "=", "ACTIVE")
    .returning(["id", "template_id", "original_filename", "content_sha256", "detected_mime_type", "size_bytes", "width_px", "height_px", "status"])
    .executeTakeFirst();
