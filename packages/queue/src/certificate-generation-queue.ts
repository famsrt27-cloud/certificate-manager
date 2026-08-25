import { Queue, Worker, type Job, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";
import { z } from "zod";

export const CERTIFICATE_GENERATION_QUEUE_NAME = "certificate-generation-v1";
export const CERTIFICATE_GENERATION_JOB_NAME = "generate-certificates";
export const CertificateGenerationJobPayloadSchema = z.object({ version: z.literal(1), job_id: z.uuid(), organization_id: z.uuid() }).strict();
export type CertificateGenerationJobPayload = z.infer<typeof CertificateGenerationJobPayloadSchema>;
const options: JobsOptions = { attempts: 3, backoff: { type: "exponential", delay: 1_000 }, removeOnComplete: 1_000, removeOnFail: 1_000 };
export interface CertificateGenerationProducer { enqueue(payload: CertificateGenerationJobPayload): Promise<void>; close(): Promise<void> }
export interface CertificateGenerationWorkerHandle { close(): Promise<void> }
export interface CertificateGenerationWorkerOptions {
  readonly connection: Redis;
  readonly prefix: string;
  readonly concurrency: number;
  readonly process: (payload: CertificateGenerationJobPayload) => Promise<void>;
  readonly onFinalFailure: (payload: CertificateGenerationJobPayload, error: Error) => Promise<void>;
}
export const createCertificateGenerationProducer = (connection: Redis, prefix: string): CertificateGenerationProducer => {
  const queue = new Queue<CertificateGenerationJobPayload>(CERTIFICATE_GENERATION_QUEUE_NAME, { connection, prefix });
  return { async enqueue(payload) { const parsed = CertificateGenerationJobPayloadSchema.parse(payload); await queue.add(CERTIFICATE_GENERATION_JOB_NAME, parsed, { ...options, jobId: `${parsed.job_id}-generate` }); }, close: () => queue.close() };
};

export const createCertificateGenerationWorker = (input: CertificateGenerationWorkerOptions): CertificateGenerationWorkerHandle => {
  if (!Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 10) {
    throw new Error("Certificate generation concurrency is invalid");
  }
  const worker = new Worker<CertificateGenerationJobPayload, void, typeof CERTIFICATE_GENERATION_JOB_NAME>(
    CERTIFICATE_GENERATION_QUEUE_NAME,
    async (job: Job<CertificateGenerationJobPayload>) => {
      if (job.name !== CERTIFICATE_GENERATION_JOB_NAME) throw new Error("Certificate generation job name is invalid");
      await input.process(CertificateGenerationJobPayloadSchema.parse(job.data));
    },
    { connection: input.connection, prefix: input.prefix, concurrency: input.concurrency }
  );
  worker.on("failed", (job, error) => {
    if (job === undefined || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    const payload = CertificateGenerationJobPayloadSchema.safeParse(job.data);
    if (payload.success) void input.onFinalFailure(payload.data, error);
  });
  return { close: () => worker.close() };
};
