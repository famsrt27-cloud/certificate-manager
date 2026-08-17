import { z } from "zod";

import { RequestMetaSchema } from "./foundation.js";

export const AdminOrganizationIdSchema = z.uuid();
export const IdempotencyKeySchema = z.string().trim().min(8).max(200).regex(/^[\x21-\x7E]+$/);
export const RecordStatusSchema = z.enum(["ACTIVE", "INACTIVE", "ARCHIVED"]);

const ResourceNameSchema = z.string().trim().min(1).max(200);
const ProjectSlugSchema = z.string().trim().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const TrainingCodeSchema = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
});
const OptionalDateOnlySchema = DateOnlySchema.nullable();
const CursorSchema = z.string().min(1).max(2_048);
const ListQueryFields = {
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: RecordStatusSchema.optional()
};

export const CreateProjectRequestSchema = z.object({
  name: ResourceNameSchema,
  slug: ProjectSlugSchema
}).strict();
export const UpdateProjectRequestSchema = z.object({
  name: ResourceNameSchema.optional(),
  slug: ProjectSlugSchema.optional()
}).strict().refine((value) => Object.keys(value).length > 0);
export const ProjectSchema = z.object({
  id: z.uuid(),
  name: ResourceNameSchema,
  slug: ProjectSlugSchema,
  status: RecordStatusSchema
});
export const ProjectResponseSchema = z.object({ data: ProjectSchema, meta: RequestMetaSchema });
export const ProjectListQuerySchema = z.object(ListQueryFields).strict();
export const ProjectListResponseSchema = z.object({
  data: z.array(ProjectSchema),
  meta: RequestMetaSchema.extend({ next_cursor: CursorSchema.nullable() })
});

const validateDates = (value: { start_date?: string | null | undefined; end_date?: string | null | undefined }): boolean =>
  value.start_date === undefined || value.end_date === undefined
  || value.start_date === null || value.end_date === null || value.end_date >= value.start_date;

export const CreateTrainingRequestSchema = z.object({
  project_id: z.uuid(),
  name: ResourceNameSchema,
  code: TrainingCodeSchema,
  start_date: OptionalDateOnlySchema.optional(),
  end_date: OptionalDateOnlySchema.optional()
}).strict().refine(validateDates, { path: ["end_date"] });
export const UpdateTrainingRequestSchema = z.object({
  name: ResourceNameSchema.optional(),
  code: TrainingCodeSchema.optional(),
  start_date: OptionalDateOnlySchema.optional(),
  end_date: OptionalDateOnlySchema.optional()
}).strict().refine((value) => Object.keys(value).length > 0).refine(validateDates, { path: ["end_date"] });
export const TrainingSchema = z.object({
  id: z.uuid(),
  project_id: z.uuid(),
  name: ResourceNameSchema,
  code: TrainingCodeSchema,
  start_date: OptionalDateOnlySchema,
  end_date: OptionalDateOnlySchema,
  status: RecordStatusSchema
});
export const TrainingResponseSchema = z.object({ data: TrainingSchema, meta: RequestMetaSchema });
export const TrainingListQuerySchema = z.object({ ...ListQueryFields, project_id: z.uuid().optional() }).strict();
export const TrainingListResponseSchema = z.object({
  data: z.array(TrainingSchema),
  meta: RequestMetaSchema.extend({ next_cursor: CursorSchema.nullable() })
});

export const ParticipantDisplayNameSchema = z.string().trim().min(1).max(200);
export const ParticipantExternalReferenceSchema = z.string().trim().min(1).max(200);
export const UpdateParticipantRequestSchema = z.object({
  display_name: ParticipantDisplayNameSchema.optional(),
  external_reference: ParticipantExternalReferenceSchema.nullable().optional()
}).strict().refine((value) => Object.keys(value).length > 0);
export const ParticipantSchema = z.object({
  id: z.uuid(),
  display_name: ParticipantDisplayNameSchema,
  external_reference: ParticipantExternalReferenceSchema.nullable()
});
export const ParticipantResponseSchema = z.object({ data: ParticipantSchema, meta: RequestMetaSchema });
export const ParticipantListQuerySchema = z.object({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  training_id: z.uuid().optional()
}).strict();
export const ParticipantListResponseSchema = z.object({
  data: z.array(ParticipantSchema),
  meta: RequestMetaSchema.extend({ next_cursor: CursorSchema.nullable() })
});

export const ParticipantImportQueuedSchema = z.object({
  job_id: z.uuid(),
  status: z.enum(["QUEUED", "RUNNING", "AWAITING_CONFIRMATION", "SUCCEEDED", "FAILED", "DEAD_LETTER", "CANCELLED"])
});
export const ParticipantImportQueuedResponseSchema = z.object({
  data: ParticipantImportQueuedSchema,
  meta: RequestMetaSchema
});
export const ImportRowValidationErrorSchema = z.object({
  code: z.enum([
    "DISPLAY_NAME_REQUIRED",
    "DISPLAY_NAME_TOO_LONG",
    "EXTERNAL_REFERENCE_TOO_LONG",
    "DUPLICATE_EXTERNAL_REFERENCE",
    "UNSUPPORTED_CELL_VALUE"
  ]),
  field: z.enum(["display_name", "external_reference", "row"])
});
export const ParticipantImportRowPreviewSchema = z.object({
  row_number: z.number().int().positive(),
  display_name: ParticipantDisplayNameSchema.nullable(),
  external_reference: ParticipantExternalReferenceSchema.nullable(),
  status: z.enum(["VALID", "INVALID", "IMPORTED", "FAILED"]),
  validation_errors: z.array(ImportRowValidationErrorSchema)
});
export const ParticipantImportInspectQuerySchema = z.object({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
}).strict();
export const ParticipantImportInspectResponseSchema = z.object({
  data: z.object({
    job_id: z.uuid(),
    status: z.enum(["QUEUED", "RUNNING", "AWAITING_CONFIRMATION", "SUCCEEDED", "FAILED", "DEAD_LETTER", "CANCELLED"]),
    progress: z.object({ completed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
    counts: z.object({ valid: z.number().int().nonnegative(), invalid: z.number().int().nonnegative() }),
    preview: z.array(ParticipantImportRowPreviewSchema)
  }),
  meta: RequestMetaSchema.extend({ next_cursor: CursorSchema.nullable() })
});
export const JobResponseSchema = z.object({
  data: z.object({
    job_id: z.uuid(),
    type: z.enum(["PARTICIPANT_IMPORT", "CERTIFICATE_GENERATION"]),
    status: z.enum(["QUEUED", "RUNNING", "AWAITING_CONFIRMATION", "SUCCEEDED", "FAILED", "DEAD_LETTER", "CANCELLED"]),
    progress: z.object({ completed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
    attempt_count: z.number().int().nonnegative(),
    error_code: z.string().regex(/^[A-Z][A-Z0-9_]*$/).nullable()
  }),
  meta: RequestMetaSchema
});

export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type CreateTrainingRequest = z.infer<typeof CreateTrainingRequestSchema>;
export type UpdateTrainingRequest = z.infer<typeof UpdateTrainingRequestSchema>;
export type Training = z.infer<typeof TrainingSchema>;
export type UpdateParticipantRequest = z.infer<typeof UpdateParticipantRequestSchema>;
export type Participant = z.infer<typeof ParticipantSchema>;
export type ImportRowValidationError = z.infer<typeof ImportRowValidationErrorSchema>;
