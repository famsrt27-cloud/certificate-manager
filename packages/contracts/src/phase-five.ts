import { z } from "zod";
import { RequestMetaSchema } from "./foundation.js";

export const CERTIFICATE_GENERATION_REQUEST_MAX_PARTICIPANTS = 1_000;

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
export type GenerateCertificatesRequest = z.infer<typeof GenerateCertificatesRequestSchema>;
