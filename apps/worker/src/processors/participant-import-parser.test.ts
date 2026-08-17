import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { parseParticipantImport } from "./participant-import-parser.js";
import type { ParticipantImportFileError } from "./participant-import-parser.js";

const limits = { maximumRows: 10, maximumUncompressedBytes: 1_000_000 };

describe("participant import parser", () => {
  it("parses only approved CSV columns and produces row-level validation", async () => {
    const rows = await parseParticipantImport(Buffer.from(
      "display_name,external_reference\nSynthetic Person,REF-1\n,REF-2\n"
    ), "text/csv", limits);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe("VALID");
    expect(rows[1]?.validationErrors).toContainEqual({ code: "DISPLAY_NAME_REQUIRED", field: "display_name" });
  });

  it("rejects unexpected columns and row-count abuse", async () => {
    await expect(parseParticipantImport(Buffer.from("display_name,email\nPerson,p@example.invalid"), "text/csv", limits))
      .rejects.toMatchObject({ code: "IMPORT_SCHEMA_INVALID" } satisfies Partial<ParticipantImportFileError>);
    await expect(parseParticipantImport(Buffer.from("display_name\nA\nB"), "text/csv",
      { ...limits, maximumRows: 1 })).rejects.toMatchObject({ code: "IMPORT_LIMIT_EXCEEDED" });
  });

  it("rejects formula cells in XLSX as row-level unsupported values", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Participants");
    sheet.addRow(["display_name", "external_reference"]);
    sheet.addRow([{ formula: "1+1", result: 2 }, "REF-1"]);
    const bytes = await workbook.xlsx.writeBuffer();
    const rows = await parseParticipantImport(new Uint8Array(bytes),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", limits);
    expect(rows[0]?.validationErrors).toContainEqual({ code: "UNSUPPORTED_CELL_VALUE", field: "row" });
  });
});
