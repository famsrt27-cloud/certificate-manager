import { describe, expect, it } from "vitest";

import { validateParticipantImportUpload } from "./participant-import-upload.js";

describe("participant import upload boundary", () => {
  it("accepts bounded UTF-8 CSV metadata and strips user-supplied path components", () => {
    expect(validateParticipantImportUpload("../../synthetic.csv", "text/csv", Buffer.from("display_name\nSynthetic Person")))
      .toEqual({ originalFilename: "synthetic.csv", detectedMimeType: "text/csv" });
  });

  it("rejects extension/MIME/signature mismatch and NUL-bearing CSV", () => {
    expect(() => validateParticipantImportUpload("payload.xlsx", "text/csv", Buffer.from("display_name\nPerson"))).toThrow();
    expect(() => validateParticipantImportUpload("payload.csv", "text/csv", Buffer.from([0x61, 0, 0x62]))).toThrow();
    expect(() => validateParticipantImportUpload("payload.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", Buffer.from("not-a-zip"))).toThrow();
  });
});
