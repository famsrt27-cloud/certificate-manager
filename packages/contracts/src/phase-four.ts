import {
  TemplateDefinitionSchema,
  type TemplateDefinition
} from "@certificate-platform/template-engine";
import { z } from "zod";

import { RequestMetaSchema } from "./foundation.js";
import { RecordStatusSchema } from "./phase-three.js";

export { TemplateDefinitionSchema } from "@certificate-platform/template-engine";

const ResourceNameSchema = z.string().trim().min(1).max(200);
const CursorSchema = z.string().min(1).max(2_048);
export const TemplateChildListQuerySchema = z.object({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
}).strict();
const HexSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const TemplateVersionStatusSchema = z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]);
export const TemplateAssetStatusSchema = z.enum(["QUARANTINED", "ACTIVE", "REJECTED", "ARCHIVED"]);

export const CreateTemplateRequestSchema = z.object({ name: ResourceNameSchema }).strict();
export const UpdateTemplateRequestSchema = z.object({ name: ResourceNameSchema }).strict();
export const TemplateSchema = z.object({
  id: z.uuid(), name: ResourceNameSchema, status: RecordStatusSchema
});
export const TemplateResponseSchema = z.object({ data: TemplateSchema, meta: RequestMetaSchema });
export const TemplateListQuerySchema = z.object({
  cursor: CursorSchema.optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
  status: RecordStatusSchema.optional()
}).strict();
export const TemplateListResponseSchema = z.object({
  data: z.array(TemplateSchema), meta: RequestMetaSchema.extend({ next_cursor: CursorSchema.nullable() })
});

export const CreateTemplateVersionRequestSchema = z.object({ definition: TemplateDefinitionSchema }).strict();
export const UpdateTemplateVersionRequestSchema = z.object({ definition: TemplateDefinitionSchema }).strict();
export const TemplateVersionSchema = z.object({
  id: z.uuid(), template_id: z.uuid(), version: z.number().int().positive(),
  definition: TemplateDefinitionSchema, asset_ids: z.array(z.uuid()), status: TemplateVersionStatusSchema,
  published_at: z.iso.datetime().nullable()
});
export const TemplateVersionResponseSchema = z.object({ data: TemplateVersionSchema, meta: RequestMetaSchema });
export const TemplateVersionListResponseSchema = z.object({ data: z.array(TemplateVersionSchema),
  meta: RequestMetaSchema.extend({ next_cursor: CursorSchema.nullable() }) });
export const DeleteDraftVersionResponseSchema = z.object({ data: z.object({ deleted: z.literal(true) }), meta: RequestMetaSchema });

export const TemplateAssetSchema = z.object({
  id: z.uuid(), template_id: z.uuid(), original_filename: z.string().min(1).max(255),
  detected_mime_type: z.enum(["image/png", "image/jpeg", "font/ttf", "font/otf"]),
  content_sha256: HexSha256Schema, size_bytes: z.number().int().positive(),
  width_px: z.number().int().positive().nullable(), height_px: z.number().int().positive().nullable(),
  status: TemplateAssetStatusSchema
});
export const TemplateAssetResponseSchema = z.object({ data: TemplateAssetSchema, meta: RequestMetaSchema });
export const TemplateAssetListResponseSchema = z.object({ data: z.array(TemplateAssetSchema),
  meta: RequestMetaSchema.extend({ next_cursor: CursorSchema.nullable() }) });

export const TemplatePreviewResponseSchema = z.object({
  data: z.object({
    definition: TemplateDefinitionSchema,
    bound_elements: z.array(z.object({ index: z.number().int().nonnegative(), value: z.string().nullable() }))
  }),
  meta: RequestMetaSchema
});

export type CreateTemplateRequest = z.infer<typeof CreateTemplateRequestSchema>;
export type UpdateTemplateRequest = z.infer<typeof UpdateTemplateRequestSchema>;
export type Template = z.infer<typeof TemplateSchema>;
export type CreateTemplateVersionRequest = { readonly definition: TemplateDefinition };
export type UpdateTemplateVersionRequest = { readonly definition: TemplateDefinition };
export type TemplateVersion = z.infer<typeof TemplateVersionSchema>;
export type TemplateAsset = z.infer<typeof TemplateAssetSchema>;
