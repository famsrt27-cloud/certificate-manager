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

const CSV_MAX_RECORD_BYTES = 4_096;
const XLSX_MAX_ENTRIES = 1_000;

const readZipEntry = (zip: ZipFile, entry: Entry): Promise<Buffer> => new Promise((resolve, reject) => {
  zip.openReadStream(entry, (error, stream) => {
    if (error !== null || stream === undefined) {
      reject(error ?? new Error("Invalid XLSX entry"));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > entry.uncompressedSize) {
        stream.destroy(new Error("XLSX entry exceeded declared size"));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    stream.once("end", () => resolve(Buffer.concat(chunks)));
    stream.once("error", reject);
  });
});

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
  if (bytes.includes(0)) throw new ParticipantImportFileError("IMPORT_FILE_INVALID");
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ParticipantImportFileError("IMPORT_FILE_INVALID");
  }
  let records: unknown;
  let recordCount = 0;
  try {
    records = parse(Buffer.from(bytes), {
      bom: true,
      encoding: "utf8",
      relax_column_count: false,
      skip_empty_lines: true,
      max_record_size: CSV_MAX_RECORD_BYTES,
      on_record: (record) => {
        recordCount += 1;
        if (recordCount > limits.maximumRows + 1) {
          throw new ParticipantImportFileError("IMPORT_LIMIT_EXCEEDED");
        }
        if (Array.isArray(record) && record.reduce((size, value, index) =>
          size + (index === 0 ? 0 : 1) + Buffer.byteLength(typeof value === "string" ? value : String(value), "utf8"), 0) > CSV_MAX_RECORD_BYTES) {
          throw new ParticipantImportFileError("IMPORT_LIMIT_EXCEEDED");
        }
        return record;
      }
    });
  } catch (error) {
    if (error instanceof ParticipantImportFileError) throw error;
    if (error instanceof Error && "code" in error && error.code === "CSV_MAX_RECORD_SIZE") {
      throw new ParticipantImportFileError("IMPORT_LIMIT_EXCEEDED");
    }
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

const columnNumber = (letters: string): number => [...letters.toUpperCase()].reduce(
  (value, character) => value * 26 + character.charCodeAt(0) - 64,
  0
);

const decodeXml = (bytes: Uint8Array): string => {
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
  }
  if (bytes.byteLength >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be", { fatal: true }).decode(bytes);
  }
  if (bytes.includes(0)) throw new Error("Unsupported XML encoding");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
};

const inspectXlsxArchive = async (bytes: Uint8Array, limits: ParticipantImportParserLimits): Promise<void> => {
  let zip: ZipFile;
  try { zip = await openZip(bytes); } catch { throw new ParticipantImportFileError("IMPORT_FILE_INVALID"); }
  await new Promise<void>((resolve, reject) => {
    let total = 0;
    let entries = 0;
    let contentTypes = false;
    let workbook = false;
    let worksheetCount = 0;
    let settled = false;
    const seenPaths = new Set<string>();
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error);
    };
    zip.on("entry", (entry: Entry) => { void (async () => {
      entries += 1;
      total += entry.uncompressedSize;
      const name = entry.fileName;
      const normalizedName = name.normalize("NFKC");
      const pathKey = normalizedName.toLowerCase();
      const segments = normalizedName.split("/");
      const unsafePath = normalizedName.startsWith("/") || normalizedName.includes("\\")
        || /^[a-z]:/i.test(normalizedName) || segments.some((segment, index) => segment === "." || segment === ".."
          || (segment.length === 0 && index !== segments.length - 1))
        || [...normalizedName].some((character) => (character.codePointAt(0) ?? 0) < 32)
        || seenPaths.has(pathKey);
      seenPaths.add(pathKey);
      const lowerName = normalizedName.toLowerCase();
      const forbiddenContent = lowerName.startsWith("xl/externallinks/") || lowerName.startsWith("xl/embeddings/")
        || lowerName === "xl/vbaproject.bin" || lowerName.startsWith("xl/oleobjects/");
      if (unsafePath || (entry.generalPurposeBitFlag & 1) !== 0 || entries > XLSX_MAX_ENTRIES
        || entry.uncompressedSize > limits.maximumUncompressedBytes || total > limits.maximumUncompressedBytes) {
        fail(new ParticipantImportFileError("IMPORT_LIMIT_EXCEEDED"));
        return;
      }
      if (forbiddenContent) {
        fail(new ParticipantImportFileError("IMPORT_FILE_INVALID"));
        return;
      }
      if (name === "[Content_Types].xml") contentTypes = true;
      if (name === "xl/workbook.xml") workbook = true;
      if (/^xl\/worksheets\/[^/]+\.xml$/i.test(normalizedName)) worksheetCount += 1;

      const inspectRelationships = lowerName.endsWith(".rels");
      const inspectContentTypes = name === "[Content_Types].xml";
      const inspectWorksheet = /^xl\/worksheets\/[^/]+\.xml$/i.test(normalizedName);
      if (inspectRelationships || inspectContentTypes || inspectWorksheet) {
        let content: string;
        try {
          const entryBytes = await readZipEntry(zip, entry);
          content = decodeXml(entryBytes);
        } catch {
          fail(new ParticipantImportFileError("IMPORT_FILE_INVALID"));
          return;
        }
        if (inspectRelationships && (/\bTargetMode\s*=/i.test(content)
          || /\/relationships\/(?:externalLink|oleObject|package)["']/i.test(content))) {
          fail(new ParticipantImportFileError("IMPORT_FILE_INVALID"));
          return;
        }
        if (inspectContentTypes && /(?:macroEnabled|vbaProject|oleObject)/i.test(content)) {
          fail(new ParticipantImportFileError("IMPORT_FILE_INVALID"));
          return;
        }
        if (inspectWorksheet) {
          for (const match of content.matchAll(/<row\b[^>]*\br\s*=\s*["']([0-9]+)["']/gi)) {
            if (Number(match[1]) > limits.maximumRows + 1) {
              fail(new ParticipantImportFileError("IMPORT_LIMIT_EXCEEDED"));
              return;
            }
          }
          for (const match of content.matchAll(/<(?:c\b[^>]*\br|dimension\b[^>]*\bref)\s*=\s*["']([A-Z]+)([0-9]+)(?::([A-Z]+)([0-9]+))?["']/gi)) {
            if (columnNumber(match[1]!) > 2 || (match[3] !== undefined && columnNumber(match[3]) > 2)) {
              fail(new ParticipantImportFileError("IMPORT_SCHEMA_INVALID"));
              return;
            }
            if (Number(match[2]) > limits.maximumRows + 1
              || (match[4] !== undefined && Number(match[4]) > limits.maximumRows + 1)) {
              fail(new ParticipantImportFileError("IMPORT_LIMIT_EXCEEDED"));
              return;
            }
          }
        }
      }
      zip.readEntry();
    })().catch(() => fail(new ParticipantImportFileError("IMPORT_FILE_INVALID"))); });
    zip.once("end", () => {
      if (settled) return;
      settled = true;
      if (contentTypes && workbook && worksheetCount === 1) resolve();
      else reject(new ParticipantImportFileError("IMPORT_FILE_INVALID"));
    });
    zip.once("error", () => fail(new ParticipantImportFileError("IMPORT_FILE_INVALID")));
    zip.readEntry();
  });
};

const parseXlsx = async (bytes: Uint8Array, limits: ParticipantImportParserLimits): Promise<readonly RawParticipantImportRow[]> => {
  await inspectXlsxArchive(bytes, limits);
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
