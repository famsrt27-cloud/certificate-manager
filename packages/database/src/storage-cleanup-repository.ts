import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";

import type { Database } from "./types.js";

export interface ClaimedStorageCleanup {
  readonly id: string;
  readonly organizationId: string;
  readonly objectKey: string;
}

export const armStorageCleanup = async (
  database: Kysely<Database>,
  input: { readonly organizationId: string; readonly objectKey: string; readonly notBefore: Date }
): Promise<void> => {
  await database.insertInto("storage_cleanup_outbox").values({
    organization_id: input.organizationId,
    object_key: input.objectKey,
    not_before: input.notBefore
  }).execute();
};

export const cancelStorageCleanupInTransaction = async (
  transaction: Transaction<Database>,
  organizationId: string,
  objectKey: string
): Promise<void> => {
  await transaction.deleteFrom("storage_cleanup_outbox")
    .where("organization_id", "=", organizationId)
    .where("object_key", "=", objectKey)
    .execute();
};

export const completeStorageCleanupByKey = async (
  database: Kysely<Database>,
  organizationId: string,
  objectKey: string
): Promise<void> => {
  await database.deleteFrom("storage_cleanup_outbox")
    .where("organization_id", "=", organizationId)
    .where("object_key", "=", objectKey)
    .execute();
};

export const completeStorageCleanup = async (
  database: Kysely<Database>,
  cleanupId: string
): Promise<void> => {
  await database.deleteFrom("storage_cleanup_outbox").where("id", "=", cleanupId).execute();
};

export const claimDueStorageCleanup = async (
  database: Kysely<Database>,
  input: { readonly limit: number; readonly claimedAt: Date; readonly retryBefore: Date }
): Promise<readonly ClaimedStorageCleanup[]> =>
  database.transaction().execute(async (transaction) => {
    const rows = await transaction.selectFrom("storage_cleanup_outbox")
      .select(["id", "organization_id", "object_key"])
      .where("not_before", "<=", input.claimedAt)
      .where((expression) => expression.or([
        expression("last_attempt_at", "is", null),
        expression("last_attempt_at", "<=", input.retryBefore)
      ]))
      .orderBy("not_before", "asc")
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .limit(input.limit)
      .forUpdate()
      .skipLocked()
      .execute();

    if (rows.length === 0) return [];

    await transaction.updateTable("storage_cleanup_outbox").set({
      attempt_count: sql<number>`attempt_count + 1`,
      last_attempt_at: input.claimedAt,
      last_error_code: null
    }).where("id", "in", rows.map((row) => row.id)).execute();

    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      objectKey: row.object_key
    }));
  });

export const markStorageCleanupFailed = async (
  database: Kysely<Database>,
  cleanupId: string,
  errorCode: string
): Promise<void> => {
  await database.updateTable("storage_cleanup_outbox")
    .set({ last_error_code: errorCode })
    .where("id", "=", cleanupId)
    .execute();
};

export const storageObjectIsReferenced = async (
  database: Kysely<Database>,
  objectKey: string
): Promise<boolean> => {
  const [templateAsset, participantImport, certificate] = await Promise.all([
    database.selectFrom("template_assets").select("id").where("storage_key", "=", objectKey).limit(1).executeTakeFirst(),
    database.selectFrom("participant_import_jobs").select("job_id")
      .where("source_storage_key", "=", objectKey).limit(1).executeTakeFirst(),
    database.selectFrom("certificates").select("id").where("pdf_storage_key", "=", objectKey).limit(1).executeTakeFirst()
  ]);
  return templateAsset !== undefined || participantImport !== undefined || certificate !== undefined;
};
