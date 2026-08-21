import {
  claimDueStorageCleanup,
  completeStorageCleanup,
  markStorageCleanupFailed,
  storageObjectIsReferenced,
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
      try {
        if (await storageObjectIsReferenced(this.#database, task.objectKey)) {
          await completeStorageCleanup(this.#database, task.id);
          protectedCount += 1;
          continue;
        }
        await this.#storage.delete(task.objectKey);
        await completeStorageCleanup(this.#database, task.id);
        deleted += 1;
      } catch {
        await markStorageCleanupFailed(this.#database, task.id, "STORAGE_DELETE_FAILED");
        failed += 1;
      }
    }

    return { claimed: tasks.length, deleted, protected: protectedCount, failed };
  }
}
