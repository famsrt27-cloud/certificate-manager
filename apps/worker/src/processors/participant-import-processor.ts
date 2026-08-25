import { createHash, timingSafeEqual } from "node:crypto";

import {
  applyParticipantImport,
  failParticipantImport,
  findParticipantImport,
  recordParticipantImportAttempt,
  stageParticipantImportRows,
  type DatabaseClient
} from "@certificate-platform/database";
import { ParticipantImportJobPayloadSchema, type ParticipantImportJobPayload } from "@certificate-platform/queue";
import type { PrivateObjectStorage } from "@certificate-platform/storage";

import { ParticipantImportFileError, parseParticipantImport } from "./participant-import-parser.js";

export interface ParticipantImportProcessorOptions {
  readonly database: DatabaseClient;
  readonly storage: PrivateObjectStorage;
  readonly maximumBytes: number;
  readonly maximumRows: number;
  readonly maximumUncompressedBytes: number;
}

export class ParticipantImportProcessor {
  readonly #database: DatabaseClient;
  readonly #storage: PrivateObjectStorage;
  readonly #maximumBytes: number;
  readonly #maximumRows: number;
  readonly #maximumUncompressedBytes: number;

  constructor(options: ParticipantImportProcessorOptions) {
    this.#database = options.database;
    this.#storage = options.storage;
    this.#maximumBytes = options.maximumBytes;
    this.#maximumRows = options.maximumRows;
    this.#maximumUncompressedBytes = options.maximumUncompressedBytes;
  }

  async process(untrustedPayload: ParticipantImportJobPayload): Promise<void> {
    const payload = ParticipantImportJobPayloadSchema.parse(untrustedPayload);
    const importJob = await findParticipantImport(this.#database, payload.organization_id, payload.job_id);
    if (importJob === undefined) throw new Error("Participant import job was not found in its organization scope");
    if (importJob.status !== "SUCCEEDED" && importJob.status !== "FAILED" && importJob.status !== "DEAD_LETTER"
      && importJob.status !== "CANCELLED") {
      await recordParticipantImportAttempt(this.#database, importJob.organizationId, importJob.jobId);
    }

    if (payload.operation === "VALIDATE") {
      if (importJob.status === "AWAITING_CONFIRMATION" || importJob.status === "SUCCEEDED") return;
      if (importJob.status === "FAILED" || importJob.status === "DEAD_LETTER" || importJob.status === "CANCELLED") return;
      try {
        const bytes = await this.#storage.get(importJob.sourceStorageKey, this.#maximumBytes);
        const actualHash = createHash("sha256").update(bytes).digest();
        const expectedHash = Buffer.from(importJob.contentSha256);
        if (actualHash.byteLength !== expectedHash.byteLength || !timingSafeEqual(actualHash, expectedHash)
          || bytes.byteLength !== importJob.sizeBytes) {
          throw new ParticipantImportFileError("IMPORT_FILE_INVALID");
        }
        const rows = await parseParticipantImport(bytes, importJob.detectedMimeType, {
          maximumRows: this.#maximumRows,
          maximumUncompressedBytes: this.#maximumUncompressedBytes
        });
        await stageParticipantImportRows(this.#database, importJob, rows);
      } catch (error) {
        if (!(error instanceof ParticipantImportFileError)) throw error;
        await failParticipantImport(this.#database, importJob.organizationId, importJob.jobId, "FAILED", error.code);
      }
      return;
    }

    if (importJob.status === "SUCCEEDED") return;
    if (importJob.status === "FAILED" || importJob.status === "DEAD_LETTER" || importJob.status === "CANCELLED") return;
    try {
      await applyParticipantImport(this.#database, importJob);
    } catch (error) {
      if (error instanceof Error && (error.message === "IMPORT_REFERENCE_CONFLICT"
        || error.message === "IMPORT_CONFIRMATION_STATE_INVALID")) {
        await failParticipantImport(this.#database, importJob.organizationId, importJob.jobId, "FAILED", error.message);
        return;
      }
      throw error;
    }
  }

  async handleFinalFailure(payload: ParticipantImportJobPayload): Promise<void> {
    const parsed = ParticipantImportJobPayloadSchema.parse(payload);
    await failParticipantImport(
      this.#database,
      parsed.organization_id,
      parsed.job_id,
      "DEAD_LETTER",
      "IMPORT_PROCESSING_FAILED"
    );
  }
}
