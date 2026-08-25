import {
  claimPendingParticipantImportSourceCleanups,
  completeParticipantImportSourceCleanup,
  markParticipantImportSourceCleanupFailed,
  type DatabaseClient
} from "@certificate-platform/database";
import type { PrivateObjectStorage } from "@certificate-platform/storage";

export interface ParticipantImportSourceCleanupResult {
  readonly claimed: number;
  readonly deleted: number;
  readonly failed: number;
}

export class ParticipantImportSourceCleanupReconciler {
  readonly #database: DatabaseClient;
  readonly #storage: PrivateObjectStorage;
  readonly #batchSize: number;
  readonly #retryDelayMs: number;
  readonly #organizationId: string | undefined;

  constructor(input: {
    readonly database: DatabaseClient;
    readonly storage: PrivateObjectStorage;
    readonly batchSize: number;
    readonly retryDelayMs: number;
    readonly organizationId?: string;
  }) {
    this.#database = input.database;
    this.#storage = input.storage;
    this.#batchSize = input.batchSize;
    this.#retryDelayMs = input.retryDelayMs;
    this.#organizationId = input.organizationId;
  }

  async runOnce(now = new Date()): Promise<ParticipantImportSourceCleanupResult> {
    const cleanups = await claimPendingParticipantImportSourceCleanups(this.#database, {
      limit: this.#batchSize,
      claimedAt: now,
      retryBefore: new Date(now.getTime() - this.#retryDelayMs),
      ...(this.#organizationId === undefined ? {} : { organizationId: this.#organizationId })
    });

    let deleted = 0;
    let failed = 0;
    for (const cleanup of cleanups) {
      try {
        await this.#storage.delete(cleanup.sourceStorageKey);
        await completeParticipantImportSourceCleanup(
          this.#database,
          cleanup.organizationId,
          cleanup.jobId,
          new Date()
        );
        deleted += 1;
      } catch {
        await markParticipantImportSourceCleanupFailed(
          this.#database,
          cleanup.organizationId,
          cleanup.jobId,
          "IMPORT_SOURCE_DELETE_FAILED"
        );
        failed += 1;
      }
    }
    return { claimed: cleanups.length, deleted, failed };
  }
}
