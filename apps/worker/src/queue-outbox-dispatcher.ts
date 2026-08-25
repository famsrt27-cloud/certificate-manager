import {
  claimPendingQueueOutbox,
  markQueueOutboxDispatched,
  markQueueOutboxFailed,
  reconcileStaleParticipantImportOutbox,
  type DatabaseClient
} from "@certificate-platform/database";
import {
  ParticipantImportJobPayloadSchema,
  type ParticipantImportJobPayload,
  type ParticipantImportProducer
} from "@certificate-platform/queue";
import { CertificateGenerationJobPayloadSchema, type CertificateGenerationProducer } from "@certificate-platform/queue";

export interface QueueOutboxDispatcherOptions {
  readonly database: DatabaseClient;
  readonly participantImports: ParticipantImportProducer;
  readonly certificateGenerations?: CertificateGenerationProducer;
  readonly batchSize?: number;
  readonly retryDelayMs?: number;
  readonly reconcileAfterMs?: number;
  readonly now?: () => Date;
}

export interface QueueOutboxDispatchResult {
  readonly claimed: number;
  readonly dispatched: number;
  readonly failed: number;
}

const validateParticipantImportMessage = (
  messageType: string,
  organizationId: string,
  payloadJson: unknown
): ParticipantImportJobPayload => {
  const payload = ParticipantImportJobPayloadSchema.parse(payloadJson);
  const expectedMessageType = payload.operation === "VALIDATE"
    ? "PARTICIPANT_IMPORT_VALIDATE"
    : "PARTICIPANT_IMPORT_CONFIRM";
  if (messageType !== expectedMessageType || payload.organization_id !== organizationId) {
    throw new Error("OUTBOX_PAYLOAD_INVALID");
  }
  return payload;
};

export class QueueOutboxDispatcher {
  readonly #database: DatabaseClient;
  readonly #participantImports: ParticipantImportProducer;
  readonly #certificateGenerations?: CertificateGenerationProducer;
  readonly #batchSize: number;
  readonly #retryDelayMs: number;
  readonly #reconcileAfterMs: number;
  readonly #now: () => Date;

  constructor(options: QueueOutboxDispatcherOptions) {
    this.#database = options.database;
    this.#participantImports = options.participantImports;
    if (options.certificateGenerations !== undefined) this.#certificateGenerations = options.certificateGenerations;
    this.#batchSize = options.batchSize ?? 100;
    this.#retryDelayMs = options.retryDelayMs ?? 5_000;
    this.#reconcileAfterMs = options.reconcileAfterMs ?? 30_000;
    this.#now = options.now ?? (() => new Date());
    if (!Number.isInteger(this.#batchSize) || this.#batchSize < 1 || this.#batchSize > 1_000) {
      throw new Error("Queue outbox batch size is invalid");
    }
    if (!Number.isInteger(this.#retryDelayMs) || this.#retryDelayMs < 0) {
      throw new Error("Queue outbox retry delay is invalid");
    }
    if (!Number.isInteger(this.#reconcileAfterMs) || this.#reconcileAfterMs < 0) {
      throw new Error("Queue outbox reconcile delay is invalid");
    }
  }

  async dispatchOnce(): Promise<QueueOutboxDispatchResult> {
    const now = this.#now();
    await reconcileStaleParticipantImportOutbox(
      this.#database,
      new Date(now.getTime() - this.#reconcileAfterMs)
    );
    const rows = await claimPendingQueueOutbox(this.#database, {
      limit: this.#batchSize,
      claimedAt: now,
      retryBefore: new Date(now.getTime() - this.#retryDelayMs)
    });

    let dispatched = 0;
    let failed = 0;
    for (const row of rows) {
      let payload: ParticipantImportJobPayload | ReturnType<typeof CertificateGenerationJobPayloadSchema.parse>;
      try {
        if (row.messageType === "CERTIFICATE_GENERATION") {
          payload = CertificateGenerationJobPayloadSchema.parse(row.payloadJson);
          if (payload.organization_id !== row.organizationId || this.#certificateGenerations === undefined) throw new Error("OUTBOX_PAYLOAD_INVALID");
        } else payload = validateParticipantImportMessage(row.messageType, row.organizationId, row.payloadJson);
      } catch {
        await markQueueOutboxFailed(this.#database, row.id, "OUTBOX_PAYLOAD_INVALID");
        failed += 1;
        continue;
      }

      try {
        if (row.messageType === "CERTIFICATE_GENERATION") await this.#certificateGenerations!.enqueue(CertificateGenerationJobPayloadSchema.parse(payload));
        else await this.#participantImports.enqueue(ParticipantImportJobPayloadSchema.parse(payload));
      } catch {
        await markQueueOutboxFailed(this.#database, row.id, "QUEUE_DISPATCH_FAILED");
        failed += 1;
        continue;
      }

      await markQueueOutboxDispatched(this.#database, row.id, this.#now());
      dispatched += 1;
    }

    return { claimed: rows.length, dispatched, failed };
  }
}
