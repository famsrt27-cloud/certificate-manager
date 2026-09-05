import {
  claimDueStorageCleanup,
  processClaimedStorageCleanup,
  type DatabaseClient
} from "@certificate-platform/database";
import type { PrivateObjectStorage } from "@certificate-platform/storage";

export interface StorageCleanupResult {
  readonly claimed: number;
  readonly deleted: number;
  readonly protected: number;
  readonly failed: number;
}

export class StorageCleanupReconciler {
  readonly #database: DatabaseClient;
  readonly #storage: PrivateObjectStorage;
  readonly #batchSize: number;
  readonly #retryDelayMs: number;

  constructor(input: {
    readonly database: DatabaseClient;
    readonly storage: PrivateObjectStorage;
    readonly batchSize: number;
    readonly retryDelayMs: number;
  }) {
    this.#database = input.database;
    this.#storage = input.storage;
    this.#batchSize = input.batchSize;
    this.#retryDelayMs = input.retryDelayMs;
  }

  async runOnce(now = new Date()): Promise<StorageCleanupResult> {
    const tasks = await claimDueStorageCleanup(this.#database, {
      limit: this.#batchSize,
      claimedAt: now,
      retryBefore: new Date(now.getTime() - this.#retryDelayMs)
    });
    let deleted = 0;
    let protectedCount = 0;
    let failed = 0;

    for (const task of tasks) {
      const outcome = await processClaimedStorageCleanup(
        this.#database, task, (objectKey) => this.#storage.delete(objectKey)
      );
      if (outcome === "DELETED") deleted += 1;
      else if (outcome === "PROTECTED") protectedCount += 1;
      else failed += 1;
    }

    return { claimed: tasks.length, deleted, protected: protectedCount, failed };
  }
}
