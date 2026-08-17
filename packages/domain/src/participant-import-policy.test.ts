import { describe, expect, it } from "vitest";

import { validateParticipantImportRows } from "./participant-import-policy.js";

describe("participant import validation policy", () => {
  it("normalizes only the two allowed fields and preserves source row numbers", () => {
    expect(validateParticipantImportRows([{ rowNumber: 2, displayName: "  Synthetic Person  ", externalReference: " REF-1 " }]))
      .toEqual([{ rowNumber: 2, displayName: "Synthetic Person", externalReference: "REF-1", status: "VALID", validationErrors: [] }]);
  });

  it("flags missing names, oversized values, unsupported cells and duplicate references", () => {
    const rows = validateParticipantImportRows([
      { rowNumber: 2, displayName: "", externalReference: "DUP" },
      { rowNumber: 3, displayName: { formula: "=1+1" }, externalReference: "DUP" }
    ]);
    expect(rows[0]?.validationErrors).toEqual(expect.arrayContaining([
      { code: "DISPLAY_NAME_REQUIRED", field: "display_name" },
      { code: "DUPLICATE_EXTERNAL_REFERENCE", field: "external_reference" }
    ]));
    expect(rows[1]?.validationErrors).toEqual(expect.arrayContaining([
      { code: "UNSUPPORTED_CELL_VALUE", field: "row" },
      { code: "DUPLICATE_EXTERNAL_REFERENCE", field: "external_reference" }
    ]));
  });
});
