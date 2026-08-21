import type { Kysely, Transaction } from "kysely";

import {
  insertAuditRecord,
  type NewAuditRecord
} from "./authentication-repository.js";
import type { Database } from "./types.js";

export interface AuditedMutationResult<T> {
  readonly result: T;
  readonly audit: NewAuditRecord | null;
}

export const runAuditedTransaction = async <T>(
  database: Kysely<Database>,
  mutation: (transaction: Transaction<Database>) => Promise<AuditedMutationResult<T>>
): Promise<T> => database.transaction().execute(async (transaction) => {
  const outcome = await mutation(transaction);
  if (outcome.audit !== null) {
    await insertAuditRecord(transaction, outcome.audit);
  }
  return outcome.result;
});
