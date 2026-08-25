import { Queue, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";
import { z } from "zod";

export const CERTIFICATE_GENERATION_QUEUE_NAME = "certificate-generation-v1";
export const CERTIFICATE_GENERATION_JOB_NAME = "generate-certificates";
export const CertificateGenerationJobPayloadSchema = z.object({ version: z.literal(1), job_id: z.uuid(), organization_id: z.uuid() }).strict();
export type CertificateGenerationJobPayload = z.infer<typeof CertificateGenerationJobPayloadSchema>;
const options: JobsOptions = { attempts: 3, backoff: { type: "exponential", delay: 1_000 }, removeOnComplete: 1_000, removeOnFail: 1_000 };
export interface CertificateGenerationProducer { enqueue(payload: CertificateGenerationJobPayload): Promise<void>; close(): Promise<void> }
export const createCertificateGenerationProducer = (connection: Redis, prefix: string): CertificateGenerationProducer => {
  const queue = new Queue<CertificateGenerationJobPayload>(CERTIFICATE_GENERATION_QUEUE_NAME, { connection, prefix });
  return { async enqueue(payload) { const parsed = CertificateGenerationJobPayloadSchema.parse(payload); await queue.add(CERTIFICATE_GENERATION_JOB_NAME, parsed, { ...options, jobId: `${parsed.job_id}-generate` }); }, close: () => queue.close() };
};
