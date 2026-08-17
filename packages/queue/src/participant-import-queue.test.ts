import { describe, expect, it } from "vitest";

import {
  PARTICIPANT_IMPORT_QUEUE_NAME,
  ParticipantImportJobPayloadSchema
} from "./participant-import-queue.js";

describe("participant import queue contract", () => {
  it("uses the stable versioned queue name and minimum internal payload", () => {
    expect(PARTICIPANT_IMPORT_QUEUE_NAME).toBe("participant-import:v1");
    expect(ParticipantImportJobPayloadSchema.parse({
      version: 1,
      job_id: "00000000-0000-4000-8000-000000000001",
      organization_id: "00000000-0000-4000-8000-000000000002",
      operation: "VALIDATE"
    })).toEqual(expect.objectContaining({ operation: "VALIDATE" }));
  });

  it("rejects PII and secrets added to a queue payload", () => {
    expect(ParticipantImportJobPayloadSchema.safeParse({
      version: 1,
      job_id: "00000000-0000-4000-8000-000000000001",
      organization_id: "00000000-0000-4000-8000-000000000002",
      operation: "CONFIRM",
      display_name: "Synthetic Person",
      source_storage_key: "private/key"
    }).success).toBe(false);
  });
});
