import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";
import yauzl, { type Entry, type ZipFile } from "yauzl";

import { validateParticipantImportRows, type RawParticipantImportRow, type ValidatedParticipantImportRow } from "@certificate-platform/domain";

const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export class ParticipantImportFileError extends Error {
  readonly code: "IMPORT_FILE_INVALID" | "IMPORT_SCHEMA_INVALID" | "IMPORT_LIMIT_EXCEEDED" | "IMPORT_EMPTY";

  constructor(code: ParticipantImportFileError["code"]) {
    super(code);
    this.name = "ParticipantImportFileError";
    this.code = code;
  }
}

export interface ParticipantImportParserLimits {
  readonly maximumRows: number;
  readonly maximumUncompressedBytes: number;
}

const validateHeaders = (headers: readonly unknown[]): { displayNameIndex: number; externalReferenceIndex: number | null } => {
  const normalized = headers.map((header) => typeof header === "string" ? header.replace(/^\uFEFF/, "").trim() : "");
  const allowed = new Set(["display_name", "external_reference"]);
  if (normalized.length < 1 || normalized.length > 2 || normalized.some((header) => !allowed.has(header))
    || new Set(normalized).size !== normalized.length || !normalized.includes("display_name")) {
    throw new ParticipantImportFileError("IMPORT_SCHEMA_INVALID");
  }
  return {
    displayNameIndex: normalized.indexOf("display_name"),
    externalReferenceIndex: normalized.includes("external_reference") ? normalized.indexOf("external_reference") : null
  };
};

const parseCsv = (bytes: Uint8Array, limits: ParticipantImportParserLimits): readonly RawParticipantImportRow[] => {
  let records: unknown;
  try {
    records = parse(Buffer.from(bytes), {
      bom: true,
      encoding: "utf8",
      relax_column_count: false,
      skip_empty_lines: true,
      max_record_size: 4_096
    });
  } catch {
    throw new ParticipantImportFileError("IMPORT_FILE_INVALID");
  }
  if (!Array.isArray(records) || records.length === 0 || !records.every(Array.isArray)) {
    throw new ParticipantImportFileError("IMPORT_SCHEMA_INVALID");
  }
  if (records.length - 1 > limits.maximumRows) throw new ParticipantImportFileError("IMPORT_LIMIT_EXCEEDED");
  const header = validateHeaders(records[0] as unknown[]);
  return (records.slice(1) as unknown[][]).map((record, index) => ({
    rowNumber: index + 2,
    displayName: record[header.displayNameIndex],
    externalReference: header.externalReferenceIndex === null ? null : record[header.externalReferenceIndex]
  }));
};

const openZip = (bytes: Uint8Array): Promise<ZipFile> => new Promise((resolve, reject) => {
  yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true }, (error, zip) => {
    if (error !== null || zip === undefined) reject(error ?? new Error("Invalid XLSX archive"));
    else resolve(zip);
  });
});

const inspectXlsxArchive = async (bytes: Uint8Array, maximumUncompressedBytes: number): Promise<void> => {
  let zip: ZipFile;
  try { zip = await openZip(bytes); } catch { throw new ParticipantImportFileError("IMPORT_FILE_INVALID"); }
  await new Promise<void>((resolve, reject) => {
    let total = 0;
    let entries = 0;
    let contentTypes = false;
    let workbook = false;
    const fail = (error: Error) => { zip.close(); reject(error); };
    zip.on("entry", (entry: Entry) => {
      entries += 1;
      total += entry.uncompressedSize;
      const name = entry.fileName;
      const unsafePath = name.startsWith("/") || name.includes("\\") || name.split("/").includes("..");
      const forbiddenContent = name.startsWith("xl/externalLinks/") || name.startsWith("xl/embeddings/")
        || name === "xl/vbaProject.bin" || name.startsWith("xl/oleObjects/");
      if (unsafePath || forbiddenContent || (entry.generalPurposeBitFlag & 1) !== 0 || entries > 1_000
        || entry.uncompressedSize > maximumUncompressedBytes || total > maximumUncompressedBytes) {
        fail(new ParticipantImportFileError("IMPORT_LIMIT_EXCEEDED"));
        return;
      }
      if (name === "[Content_Types].xml") contentTypes = true;
      if (name === "xl/workbook.xml") workbook = true;
      zip.readEntry();
    });
    zip.once("end", () => contentTypes && workbook ? resolve() : reject(new ParticipantImportFileError("IMPORT_FILE_INVALID")));
    zip.once("error", () => reject(new ParticipantImportFileError("IMPORT_FILE_INVALID")));
    zip.readEntry();
  });
};

const parseXlsx = async (bytes: Uint8Array, limits: ParticipantImportParserLimits): Promise<readonly RawParticipantImportRow[]> => {
  await inspectXlsxArchive(bytes, limits.maximumUncompressedBytes);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0], {
      ignoreNodes: ["dataValidations", "extLst", "drawing", "picture"]
    });
  } catch {
    throw new ParticipantImportFileError("IMPORT_FILE_INVALID");
  }
  if (workbook.worksheets.length !== 1) throw new ParticipantImportFileError("IMPORT_SCHEMA_INVALID");
  const worksheet = workbook.worksheets[0]!;
  if (worksheet.actualRowCount === 0) throw new ParticipantImportFileError("IMPORT_EMPTY");
  if (worksheet.actualRowCount - 1 > limits.maximumRows) throw new ParticipantImportFileError("IMPORT_LIMIT_EXCEEDED");
  if (worksheet.actualColumnCount < 1 || worksheet.actualColumnCount > 2) throw new ParticipantImportFileError("IMPORT_SCHEMA_INVALID");
  const headers = Array.from({ length: worksheet.actualColumnCount }, (_, index) => worksheet.getCell(1, index + 1).value);
  const header = validateHeaders(headers);
  const rows: RawParticipantImportRow[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    rows.push({ rowNumber, displayName: row.getCell(header.displayNameIndex + 1).value,
      externalReference: header.externalReferenceIndex === null ? null : row.getCell(header.externalReferenceIndex + 1).value });
  });
  if (rows.length > limits.maximumRows) throw new ParticipantImportFileError("IMPORT_LIMIT_EXCEEDED");
  return rows;
};

export const parseParticipantImport = async (bytes: Uint8Array, detectedMimeType: string,
  limits: ParticipantImportParserLimits): Promise<readonly ValidatedParticipantImportRow[]> => {
  const rows = detectedMimeType === "text/csv" ? parseCsv(bytes, limits)
    : detectedMimeType === XLSX_MIME_TYPE ? await parseXlsx(bytes, limits)
      : (() => { throw new ParticipantImportFileError("IMPORT_FILE_INVALID"); })();
  if (rows.length === 0) throw new ParticipantImportFileError("IMPORT_EMPTY");
  return validateParticipantImportRows(rows);
};
