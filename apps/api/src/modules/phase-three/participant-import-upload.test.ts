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

  it("accepts spreadsheet-looking CSV fields as literal UTF-8 data", () => {
    expect(validateParticipantImportUpload("literal.csv", "application/csv",
      Buffer.from("display_name\n=not-a-formula-sink\n+literal\n-literal\n@literal")))
      .toMatchObject({ detectedMimeType: "text/csv" });
  });

  it.each([
    Buffer.from([0xff, 0xfe]),
    Buffer.from([0xc3, 0x28]),
    Buffer.from("display_name\0Person")
  ])("rejects invalid UTF-8 or NUL bytes before private storage", (bytes) => {
    expect(() => validateParticipantImportUpload("payload.csv", "text/csv", bytes)).toThrow();
  });

  it.each([
    "../participants.csv", "..\\participants.csv", "/absolute/participants.csv", "C:\\Windows\\participants.csv",
    "\\\\server\\share\\participants.csv", "e\u0301.csv"
  ])("keeps only a normalized display filename", (filename) => {
    const result = validateParticipantImportUpload(filename, "text/csv", Buffer.from("display_name\nPerson"));
    expect(result.originalFilename).not.toMatch(/[\\/]/);
    expect(result.originalFilename).toMatch(/\.csv$/);
  });

  it("removes filename controls and rejects overlong or unsupported double-extension names", () => {
    const bytes = Buffer.from("display_name\nPerson");
    expect(validateParticipantImportUpload("control\u0001.csv", "text/csv", bytes).originalFilename).toBe("control.csv");
    expect(() => validateParticipantImportUpload(`${"x".repeat(256)}.csv`, "text/csv", bytes)).toThrow();
    expect(() => validateParticipantImportUpload("participants.csv.exe", "text/csv", bytes)).toThrow();
  });
});
