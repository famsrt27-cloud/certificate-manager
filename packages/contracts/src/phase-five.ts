import { z } from "zod";
import { RequestMetaSchema } from "./foundation.js";

export const CERTIFICATE_GENERATION_REQUEST_MAX_PARTICIPANTS = 1_000;
export const CertificateStatusSchema = z.enum(["DRAFT", "GENERATING", "ISSUED", "AVAILABLE", "REVOKED", "ARCHIVED"]);
const CursorSchema = z.string().min(1).max(2_048);

export const GenerateCertificatesRequestSchema = z.object({
  template_version_id: z.uuid(),
  participant_ids: z.array(z.uuid()).min(1).max(CERTIFICATE_GENERATION_REQUEST_MAX_PARTICIPANTS).refine(
    (participantIds) => new Set(participantIds.map((participantId) => participantId.toLowerCase())).size === participantIds.length,
    { message: "Participant IDs must be unique" }
  ).optional()
}).strict();
export const CertificateGenerationQueuedResponseSchema = z.object({
  data: z.object({ job_id: z.uuid(), status: z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "DEAD_LETTER", "CANCELLED"]) }),
  meta: RequestMetaSchema
});
export const CertificateListQuerySchema = z.object({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  training_id: z.uuid().optional(),
  status: CertificateStatusSchema.optional()
}).strict();
export const AdminCertificateSchema = z.object({
  id: z.uuid(),
  certificate_number: z.string().trim().min(1).max(200),
  status: CertificateStatusSchema,
  recipient_display_name: z.string().trim().min(1).max(200),
  project_name: z.string().trim().min(1).max(200),
  training_name: z.string().trim().min(1).max(200),
  training_code: z.string().trim().min(1).max(100),
  training_id: z.uuid(),
  issued_at: z.iso.datetime().nullable(),
  revoked_at: z.iso.datetime().nullable(),
  revocation_reason: z.string().trim().min(1).max(500).nullable()
});
export const CertificateListResponseSchema = z.object({
  data: z.array(AdminCertificateSchema),
  meta: RequestMetaSchema.extend({ next_cursor: CursorSchema.nullable() })
});
export const RevokeCertificateRequestSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export const AdminCertificateResponseSchema = z.object({ data: AdminCertificateSchema, meta: RequestMetaSchema });
export type GenerateCertificatesRequest = z.infer<typeof GenerateCertificatesRequestSchema>;
export type AdminCertificate = z.infer<typeof AdminCertificateSchema>;
export type RevokeCertificateRequest = z.infer<typeof RevokeCertificateRequestSchema>;
