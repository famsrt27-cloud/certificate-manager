import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { Database, JsonValue } from "./types.js";

export type QueueOutboxMessageType = "PARTICIPANT_IMPORT_VALIDATE" | "PARTICIPANT_IMPORT_CONFIRM";

export interface ClaimedQueueOutboxRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly messageType: string;
  readonly deduplicationKey: string;
  readonly payloadJson: JsonValue;
}

export interface ClaimQueueOutboxInput {
  readonly limit: number;
  readonly claimedAt: Date;
  readonly retryBefore: Date;
}

export const claimPendingQueueOutbox = async (
  database: Kysely<Database>,
  input: ClaimQueueOutboxInput
): Promise<readonly ClaimedQueueOutboxRecord[]> =>
  database.transaction().execute(async (transaction) => {
    const rows = await transaction.selectFrom("queue_outbox")
      .select(["id", "organization_id", "message_type", "deduplication_key", "payload_json"])
      .where("dispatched_at", "is", null)
      .where((expression) => expression.or([
        expression("last_attempt_at", "is", null),
        expression("last_attempt_at", "<=", input.retryBefore)
      ]))
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .limit(input.limit)
      .forUpdate()
      .skipLocked()
      .execute();

    if (rows.length === 0) return [];

    await transaction.updateTable("queue_outbox").set({
      attempt_count: sql<number>`attempt_count + 1`,
      last_attempt_at: input.claimedAt,
      last_error_code: null
    }).where("id", "in", rows.map((row) => row.id)).execute();

    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      messageType: row.message_type,
      deduplicationKey: row.deduplication_key,
      payloadJson: row.payload_json
    }));
  });

export const markQueueOutboxDispatched = async (
  database: Kysely<Database>,
  outboxId: string,
  dispatchedAt: Date
): Promise<void> => {
  await database.updateTable("queue_outbox").set({
    dispatched_at: dispatchedAt,
    last_error_code: null
  }).where("id", "=", outboxId).where("dispatched_at", "is", null).execute();
};

export const markQueueOutboxFailed = async (
  database: Kysely<Database>,
  outboxId: string,
  errorCode: string
): Promise<void> => {
  await database.updateTable("queue_outbox").set({
    last_error_code: errorCode
  }).where("id", "=", outboxId).where("dispatched_at", "is", null).execute();
};

export const reconcileStaleParticipantImportOutbox = async (
  database: Kysely<Database>,
  staleBefore: Date
): Promise<void> => {
  await sql`
    INSERT INTO queue_outbox (
      organization_id,
      message_type,
      deduplication_key,
      payload_json
    )
    SELECT
      job.organization_id,
      CASE
        WHEN detail.confirmed_at IS NULL THEN 'PARTICIPANT_IMPORT_VALIDATE'
        ELSE 'PARTICIPANT_IMPORT_CONFIRM'
      END,
      job.id::text || CASE
        WHEN detail.confirmed_at IS NULL THEN '-validate'
        ELSE '-confirm'
      END,
      jsonb_build_object(
        'version', 1,
        'job_id', job.id,
        'organization_id', job.organization_id,
        'operation', CASE
          WHEN detail.confirmed_at IS NULL THEN 'VALIDATE'
          ELSE 'CONFIRM'
        END
      )
    FROM jobs AS job
    INNER JOIN participant_import_jobs AS detail
      ON detail.job_id = job.id
      AND detail.organization_id = job.organization_id
    WHERE job.job_type = 'PARTICIPANT_IMPORT'
      AND job.status = 'QUEUED'
      AND job.queued_at <= ${staleBefore}
    ON CONFLICT (organization_id, message_type, deduplication_key)
    DO UPDATE SET
      dispatched_at = NULL,
      last_error_code = NULL
    WHERE queue_outbox.dispatched_at IS NOT NULL
      AND queue_outbox.dispatched_at <= ${staleBefore}
  `.execute(database);
};

export const reconcileStaleCertificateGenerationOutbox = async (
  database: Kysely<Database>,
  staleBefore: Date
): Promise<void> => {
  await sql`
    INSERT INTO queue_outbox (
      organization_id,
      message_type,
      deduplication_key,
      payload_json
    )
    SELECT
      job.organization_id,
      'CERTIFICATE_GENERATION',
      job.id::text || '-generate',
      jsonb_build_object(
        'version', 1,
        'job_id', job.id,
        'organization_id', job.organization_id
      )
    FROM jobs AS job
    INNER JOIN certificate_generation_jobs AS detail
      ON detail.job_id = job.id
      AND detail.organization_id = job.organization_id
    WHERE job.job_type = 'CERTIFICATE_GENERATION'
      AND job.status IN ('QUEUED', 'RUNNING')
      AND job.updated_at <= ${staleBefore}
      AND EXISTS (
        SELECT 1
        FROM certificate_generation_items AS item
        WHERE item.job_id = job.id
          AND item.organization_id = job.organization_id
          AND (
            item.status IN ('PENDING', 'FAILED')
            OR (item.status = 'RUNNING' AND item.updated_at <= ${staleBefore})
          )
      )
    ON CONFLICT (organization_id, message_type, deduplication_key)
    DO UPDATE SET
      dispatched_at = NULL,
      last_error_code = NULL
    WHERE queue_outbox.dispatched_at IS NOT NULL
      AND queue_outbox.dispatched_at <= ${staleBefore}
  `.execute(database);
};
