export type ImportValidationCode =
  | "DISPLAY_NAME_REQUIRED"
  | "DISPLAY_NAME_TOO_LONG"
  | "EXTERNAL_REFERENCE_TOO_LONG"
  | "DUPLICATE_EXTERNAL_REFERENCE"
  | "UNSUPPORTED_CELL_VALUE";

export interface ImportValidationIssue {
  readonly code: ImportValidationCode;
  readonly field: "display_name" | "external_reference" | "row";
}

export interface RawParticipantImportRow {
  readonly rowNumber: number;
  readonly displayName: unknown;
  readonly externalReference: unknown;
}

export interface ValidatedParticipantImportRow {
  readonly rowNumber: number;
  readonly displayName: string | null;
  readonly externalReference: string | null;
  readonly status: "VALID" | "INVALID";
  readonly validationErrors: readonly ImportValidationIssue[];
}

const normalizeCell = (value: unknown): { value: string | null; supported: boolean } => {
  if (value === null || value === undefined || value === "") return { value: null, supported: true };
  if (typeof value !== "string" && typeof value !== "number") return { value: null, supported: false };
  const normalized = String(value).normalize("NFC").trim();
  return { value: normalized.length === 0 ? null : normalized, supported: true };
};
export const validateParticipantImportRows = (
  rows: readonly RawParticipantImportRow[]
): readonly ValidatedParticipantImportRow[] => {
  const externalReferenceCounts = new Map<string, number>();
  const normalized = rows.map((row) => {
    const displayName = normalizeCell(row.displayName);
    const externalReference = normalizeCell(row.externalReference);
    if (externalReference.supported && externalReference.value !== null) {
      externalReferenceCounts.set(externalReference.value, (externalReferenceCounts.get(externalReference.value) ?? 0) + 1);
    }
    return { row, displayName, externalReference };
  });

  return normalized.map(({ row, displayName, externalReference }) => {
    const validationErrors: ImportValidationIssue[] = [];
    if (!displayName.supported || !externalReference.supported) {
      validationErrors.push({ code: "UNSUPPORTED_CELL_VALUE", field: "row" });
    }
    if (displayName.supported && displayName.value === null) {
      validationErrors.push({ code: "DISPLAY_NAME_REQUIRED", field: "display_name" });
    } else if (displayName.value !== null && displayName.value.length > 200) {
      validationErrors.push({ code: "DISPLAY_NAME_TOO_LONG", field: "display_name" });
    }
    if (externalReference.value !== null && externalReference.value.length > 200) {
      validationErrors.push({ code: "EXTERNAL_REFERENCE_TOO_LONG", field: "external_reference" });
    }
    if (externalReference.value !== null && (externalReferenceCounts.get(externalReference.value) ?? 0) > 1) {
      validationErrors.push({ code: "DUPLICATE_EXTERNAL_REFERENCE", field: "external_reference" });
    }
    return {
      rowNumber: row.rowNumber,
      displayName: displayName.value !== null && displayName.value.length <= 200 ? displayName.value : null,
      externalReference: externalReference.value !== null && externalReference.value.length <= 200 ? externalReference.value : null,
      status: validationErrors.length === 0 ? "VALID" : "INVALID",
      validationErrors
    };
  });
};
