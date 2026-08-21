import { Queue, Worker, type Job, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";
import { z } from "zod";

export const PARTICIPANT_IMPORT_QUEUE_NAME = "participant-import-v1";
export const PARTICIPANT_IMPORT_JOB_NAMES = {
  validate: "validate-participant-import",
  confirm: "confirm-participant-import"
} as const;

export const ParticipantImportJobPayloadSchema = z.object({
  version: z.literal(1),
  job_id: z.uuid(),
  organization_id: z.uuid(),
  operation: z.enum(["VALIDATE", "CONFIRM"])
}).strict();

export type ParticipantImportJobPayload = z.infer<typeof ParticipantImportJobPayloadSchema>;
export type ParticipantImportJobName = (typeof PARTICIPANT_IMPORT_JOB_NAMES)[keyof typeof PARTICIPANT_IMPORT_JOB_NAMES];

const jobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1_000 },
  removeOnComplete: 1_000,
  removeOnFail: 1_000
};

export interface ParticipantImportProducer {
  enqueue(payload: ParticipantImportJobPayload): Promise<void>;
  close(): Promise<void>;
}

export interface ParticipantImportWorkerHandle {
  close(): Promise<void>;
}

export interface ParticipantImportWorkerOptions {
  readonly connection: Redis;
  readonly prefix: string;
  readonly concurrency: number;
  readonly process: (payload: ParticipantImportJobPayload) => Promise<void>;
  readonly onFinalFailure: (payload: ParticipantImportJobPayload, error: Error) => Promise<void>;
}

export const createParticipantImportProducer = (
  connection: Redis,
  prefix: string
): ParticipantImportProducer => {
  const queue = new Queue<ParticipantImportJobPayload, void, ParticipantImportJobName>(
    PARTICIPANT_IMPORT_QUEUE_NAME,
    { connection, prefix }
  );
  return {
    async enqueue(payload) {
      const parsed = ParticipantImportJobPayloadSchema.parse(payload);
      const jobName = parsed.operation === "VALIDATE"
        ? PARTICIPANT_IMPORT_JOB_NAMES.validate
        : PARTICIPANT_IMPORT_JOB_NAMES.confirm;
      await queue.add(jobName, parsed, {
        ...jobOptions,
        jobId: `${parsed.job_id}-${parsed.operation.toLowerCase()}`
      });
    },
    async close() {
      await queue.close();
    }
  };
};

export const createParticipantImportWorker = (options: ParticipantImportWorkerOptions): ParticipantImportWorkerHandle => {
  const worker = new Worker<ParticipantImportJobPayload, void, ParticipantImportJobName>(
    PARTICIPANT_IMPORT_QUEUE_NAME,
    async (job: Job<ParticipantImportJobPayload>) => {
      const payload = ParticipantImportJobPayloadSchema.parse(job.data);
      const expectedName = payload.operation === "VALIDATE"
        ? PARTICIPANT_IMPORT_JOB_NAMES.validate
        : PARTICIPANT_IMPORT_JOB_NAMES.confirm;
      if (job.name !== expectedName) throw new Error("Participant import job name and payload operation differ");
      await options.process(payload);
    },
    { connection: options.connection, prefix: options.prefix, concurrency: options.concurrency }
  );
  worker.on("failed", (job, error) => {
    if (job === undefined || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    const parsed = ParticipantImportJobPayloadSchema.safeParse(job.data);
    if (parsed.success) void options.onFinalFailure(parsed.data, error);
  });
  return { close: () => worker.close() };
};
