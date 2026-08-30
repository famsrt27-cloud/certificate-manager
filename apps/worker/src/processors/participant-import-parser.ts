import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { SaxesParser, type SaxesTagNS } from "saxes";
import yauzl, { type Entry, type ZipFile } from "yauzl";

import { validateParticipantImportRows, type RawParticipantImportRow, type ValidatedParticipantImportRow } from "@certificate-platform/domain";

const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export class ParticipantImportFileError extends Error {
  readonly code: "IMPORT_FILE_INVALID" | "IMPORT_SCHEMA_INVALID" | "IMPORT_LIMIT_EXCEEDED" | "IMPORT_EMPTY";

  constructor(code: ParticipantImportFileError["code"], options?: ErrorOptions) {
    super(code, options);
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
const CONTENT_TYPES_PATH = "[Content_Types].xml";
const WORKBOOK_PATH = "xl/workbook.xml";
const WORKBOOK_RELATIONSHIPS_PATH = "xl/_rels/workbook.xml.rels";
const ROOT_RELATIONSHIPS_PATH = "_rels/.rels";
const CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types";
const RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships";
const SPREADSHEET_NAMESPACE = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const WORKBOOK_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
const WORKSHEET_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
const EXCELJS_SPREADSHEET_XML_PATHS = [
  /^xl\/workbook\.xml$/,
  /^xl\/(?:sharedStrings|styles|calcChain)\.xml$/,
  /^xl\/worksheets\/[^/]+\.xml$/,
  /^xl\/tables\/[^/]+\.xml$/,
  /^xl\/comments[0-9]+\.xml$/
] as const;

interface OoxmlRelationship {
  readonly type: string;
  readonly target: string;
}

interface OoxmlContentTypes {
  readonly defaults: ReadonlyMap<string, string>;
  readonly overrides: ReadonlyMap<string, string>;
}

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

const xmlAttribute = (tag: SaxesTagNS, localName: string): string | undefined =>
  Object.values(tag.attributes).find((attribute) => attribute.local === localName && attribute.uri === "")?.value;

const parseBoundedXml = (content: string, onOpenTag: (tag: SaxesTagNS) => void): void => {
  const parser = new SaxesParser({ xmlns: true, position: false });
  parser.on("doctype", () => { throw new Error("OOXML DTDs are not allowed"); });
  parser.on("opentag", onOpenTag);
  parser.write(content).close();
};

const escapeXmlText = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const escapeXmlAttribute = (value: string): string => escapeXmlText(value).replaceAll("\"", "&quot;")
  .replaceAll("\t", "&#x9;").replaceAll("\n", "&#xA;").replaceAll("\r", "&#xD;");

const normalizeSpreadsheetXmlNamespaces = (content: string): string | undefined => {
  const parser = new SaxesParser({ xmlns: true, position: false });
  const output: string[] = [];
  const elements: { readonly outputName: string; readonly selfClosing: boolean; readonly defaultNamespace: string }[] = [];
  let foundRoot = false;
  let foundPrefixedSpreadsheetElement = false;
  parser.on("doctype", () => { throw new Error("OOXML DTDs are not allowed"); });
  parser.on("xmldecl", (declaration) => {
    const standalone = declaration.standalone === undefined ? "" : ` standalone="${escapeXmlAttribute(declaration.standalone)}"`;
    output.push(`<?xml version="${escapeXmlAttribute(declaration.version ?? "1.0")}" encoding="UTF-8"${standalone}?>`);
  });
  parser.on("processinginstruction", ({ target, body }) => output.push(`<?${target}${body.length === 0 ? "" : ` ${body}`}?>`));
  parser.on("comment", (comment) => output.push(`<!--${comment}-->`));
  parser.on("cdata", (cdata) => output.push(`<![CDATA[${cdata}]]>`));
  parser.on("text", (text) => output.push(escapeXmlText(text)));
  parser.on("opentag", (tag) => {
    if (!foundRoot) {
      if (tag.uri !== SPREADSHEET_NAMESPACE) throw new Error("Unexpected OOXML compatibility root namespace");
      foundRoot = true;
    }
    const outputName = tag.uri === SPREADSHEET_NAMESPACE ? tag.local : tag.name;
    if (tag.uri === SPREADSHEET_NAMESPACE && tag.prefix.length > 0) foundPrefixedSpreadsheetElement = true;
    const parentDefaultNamespace = elements.at(-1)?.defaultNamespace ?? "";
    const outputUsesDefaultNamespace = !outputName.includes(":");
    const explicitDefaultNamespace = Object.values(tag.attributes)
      .find((attribute) => attribute.name === "xmlns")?.value;
    let defaultNamespace = explicitDefaultNamespace ?? parentDefaultNamespace;
    if (outputUsesDefaultNamespace) defaultNamespace = tag.uri;

    output.push(`<${outputName}`);
    for (const attribute of Object.values(tag.attributes)) {
      if (attribute.name !== "xmlns") output.push(` ${attribute.name}="${escapeXmlAttribute(attribute.value)}"`);
    }
    if (defaultNamespace !== parentDefaultNamespace) output.push(` xmlns="${escapeXmlAttribute(defaultNamespace)}"`);
    output.push(tag.isSelfClosing ? "/>" : ">");
    elements.push({ outputName, selfClosing: tag.isSelfClosing, defaultNamespace });
  });
  parser.on("closetag", () => {
    const element = elements.pop();
    if (element === undefined) throw new Error("Invalid OOXML element stack");
    if (!element.selfClosing) output.push(`</${element.outputName}>`);
  });
  parser.write(content).close();
  if (!foundRoot) throw new Error("Empty OOXML compatibility part");
  return foundPrefixedSpreadsheetElement ? output.join("") : undefined;
};

const normalizeXlsxForExcelJs = async (bytes: Uint8Array): Promise<Buffer> => {
  const archive = await JSZip.loadAsync(Buffer.from(bytes), { checkCRC32: true, createFolders: false });
  let changed = false;
  for (const [path, entry] of Object.entries(archive.files)) {
    if (entry.dir || !EXCELJS_SPREADSHEET_XML_PATHS.some((pattern) => pattern.test(path))) continue;
    const entryBytes = await entry.async("uint8array");
    const normalized = normalizeSpreadsheetXmlNamespaces(decodeXml(entryBytes));
    if (normalized === undefined) continue;
    archive.file(path, normalized, { date: entry.date, comment: entry.comment });
    changed = true;
  }
  if (!changed) return Buffer.from(bytes);
  return archive.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    platform: "DOS"
  });
};

const xlsxDeveloperCause = (stage: "namespace-normalization" | "exceljs-load", cause: unknown): Error =>
  new Error(`XLSX ${stage} failed`, { cause });

const parseContentTypes = (content: string): OoxmlContentTypes => {
  let foundRoot = false;
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  parseBoundedXml(content, (tag) => {
    if (!foundRoot) {
      if (tag.local !== "Types" || tag.uri !== CONTENT_TYPES_NAMESPACE) throw new Error("Invalid OOXML content types root");
      foundRoot = true;
      return;
    }
    if ((tag.local !== "Override" && tag.local !== "Default") || tag.uri !== CONTENT_TYPES_NAMESPACE) return;
    const contentType = xmlAttribute(tag, "ContentType");
    if (contentType === undefined || /(?:activeX|macroEnabled|vbaProject|oleObject)/i.test(contentType)) {
      throw new Error("Unsafe OOXML content type");
    }
    if (tag.local === "Default") {
      const extension = xmlAttribute(tag, "Extension")?.toLowerCase();
      if (extension === undefined || extension.length === 0 || extension.includes("/") || extension.includes("\\")
        || defaults.has(extension)) {
        throw new Error("Invalid OOXML default content type");
      }
      defaults.set(extension, contentType);
      return;
    }
    const partName = xmlAttribute(tag, "PartName");
    if (partName === undefined || !partName.startsWith("/")
      || partName.includes("\\") || partName.split("/").some((segment) => segment === "." || segment === "..")
      || overrides.has(partName)) {
      throw new Error("Invalid OOXML content type override");
    }
    overrides.set(partName, contentType);
  });
  if (!foundRoot) throw new Error("Invalid OOXML content types document");
  return { defaults, overrides };
};

const resolveContentType = (contentTypes: OoxmlContentTypes, partPath: string): string | undefined => {
  const override = contentTypes.overrides.get(`/${partPath}`);
  if (override !== undefined) return override;
  const fileName = partPath.slice(partPath.lastIndexOf("/") + 1);
  const extensionIndex = fileName.lastIndexOf(".");
  return extensionIndex < 0 ? undefined : contentTypes.defaults.get(fileName.slice(extensionIndex + 1).toLowerCase());
};

const parseRelationships = (content: string): readonly OoxmlRelationship[] => {
  let foundRoot = false;
  const ids = new Set<string>();
  const relationships: OoxmlRelationship[] = [];
  parseBoundedXml(content, (tag) => {
    if (!foundRoot) {
      if (tag.local !== "Relationships" || tag.uri !== RELATIONSHIPS_NAMESPACE) throw new Error("Invalid OOXML relationships root");
      foundRoot = true;
      return;
    }
    if (tag.local !== "Relationship" || tag.uri !== RELATIONSHIPS_NAMESPACE) return;
    const id = xmlAttribute(tag, "Id");
    const type = xmlAttribute(tag, "Type");
    const target = xmlAttribute(tag, "Target");
    const targetMode = xmlAttribute(tag, "TargetMode");
    if (id === undefined || id.length === 0 || ids.has(id) || type === undefined || target === undefined || target.length === 0
      || (targetMode !== undefined && targetMode.toLowerCase() !== "internal")) {
      throw new Error("Invalid or external OOXML relationship");
    }
    const lowerType = type.toLowerCase();
    if (/\/relationships\/(?:control|externallink|hyperlink|oleobject|package)$/.test(lowerType)
      || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//") || target.includes("\\")
      || target.includes("?") || target.includes("#")) {
      throw new Error("Unsafe OOXML relationship");
    }
    ids.add(id);
    relationships.push({ type, target });
  });
  if (!foundRoot) throw new Error("Invalid OOXML relationships document");
  return relationships;
};

const normalizeRelationshipTarget = (baseDirectory: string, target: string): string => {
  const rooted = target.startsWith("/");
  const segments = `${rooted ? "" : baseDirectory}/${target}`.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === ".." || segment.includes(":"))) {
    throw new Error("Unsafe OOXML relationship target");
  }
  return segments.join("/");
};

const inspectWorksheetXml = (content: string, limits: ParticipantImportParserLimits): void => {
  const checkCellReference = (reference: string): void => {
    const match = /^([A-Za-z]+)([0-9]+)$/.exec(reference);
    if (match === null) return;
    if (columnNumber(match[1]!) > 2) throw new ParticipantImportFileError("IMPORT_SCHEMA_INVALID");
    if (Number(match[2]) > limits.maximumRows + 1) throw new ParticipantImportFileError("IMPORT_LIMIT_EXCEEDED");
  };
  parseBoundedXml(content, (tag) => {
    if (tag.uri !== SPREADSHEET_NAMESPACE && tag.uri !== "") return;
    if (tag.local === "row") {
      const row = xmlAttribute(tag, "r");
      if (row !== undefined && /^[0-9]+$/.test(row) && Number(row) > limits.maximumRows + 1) {
        throw new ParticipantImportFileError("IMPORT_LIMIT_EXCEEDED");
      }
    }
    if (tag.local === "c") {
      const reference = xmlAttribute(tag, "r");
      if (reference !== undefined) checkCellReference(reference);
    }
    if (tag.local === "dimension") {
      const reference = xmlAttribute(tag, "ref");
      if (reference !== undefined) reference.split(":").forEach(checkCellReference);
    }
  });
};

const validateXlsxPackageSemantics = (contentTypesContent: string | undefined,
  relationshipDocuments: ReadonlyMap<string, readonly OoxmlRelationship[]>, workbookFound: boolean,
  worksheetPaths: readonly string[]): void => {
  if (contentTypesContent === undefined) throw new ParticipantImportFileError("IMPORT_FILE_INVALID");
  const contentTypes = parseContentTypes(contentTypesContent);
  if (!workbookFound || worksheetPaths.length !== 1
    || resolveContentType(contentTypes, WORKBOOK_PATH) !== WORKBOOK_CONTENT_TYPE
    || resolveContentType(contentTypes, worksheetPaths[0]!) !== WORKSHEET_CONTENT_TYPE) {
    throw new ParticipantImportFileError("IMPORT_FILE_INVALID");
  }
  const rootRelationships = relationshipDocuments.get(ROOT_RELATIONSHIPS_PATH) ?? [];
  const officeDocumentRelationships = rootRelationships.filter((relationship) =>
    relationship.type.toLowerCase().endsWith("/relationships/officedocument"));
  const workbookRelationships = relationshipDocuments.get(WORKBOOK_RELATIONSHIPS_PATH) ?? [];
  const worksheetRelationships = workbookRelationships.filter((relationship) =>
    relationship.type.toLowerCase().endsWith("/relationships/worksheet"));
  if (officeDocumentRelationships.length !== 1 || worksheetRelationships.length !== 1
    || normalizeRelationshipTarget("", officeDocumentRelationships[0]!.target) !== WORKBOOK_PATH
    || normalizeRelationshipTarget("xl", worksheetRelationships[0]!.target) !== worksheetPaths[0]) {
    throw new ParticipantImportFileError("IMPORT_FILE_INVALID");
  }
};

const inspectXlsxArchive = async (bytes: Uint8Array, limits: ParticipantImportParserLimits): Promise<void> => {
  let zip: ZipFile;
  try { zip = await openZip(bytes); } catch { throw new ParticipantImportFileError("IMPORT_FILE_INVALID"); }
  await new Promise<void>((resolve, reject) => {
    let total = 0;
    let entries = 0;
    let contentTypesContent: string | undefined;
    let workbookFound = false;
    const worksheetPaths: string[] = [];
    const relationshipDocuments = new Map<string, readonly OoxmlRelationship[]>();
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
      const forbiddenContent = lowerName.startsWith("xl/activex/") || lowerName.startsWith("xl/externallinks/") || lowerName.startsWith("xl/embeddings/")
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
      if (name === WORKBOOK_PATH) workbookFound = true;
      if (/^xl\/worksheets\/[^/]+\.xml$/i.test(normalizedName)) worksheetPaths.push(normalizedName);

      const inspectRelationships = lowerName.endsWith(".rels");
      const inspectContentTypes = name === CONTENT_TYPES_PATH;
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
        if (inspectRelationships) relationshipDocuments.set(normalizedName, parseRelationships(content));
        if (inspectContentTypes) contentTypesContent = content;
        if (inspectWorksheet) inspectWorksheetXml(content, limits);
      }
      zip.readEntry();
    })().catch((error: unknown) => fail(error instanceof ParticipantImportFileError
      ? error : new ParticipantImportFileError("IMPORT_FILE_INVALID"))); });
    zip.once("end", () => {
      if (settled) return;
      settled = true;
      try {
        validateXlsxPackageSemantics(contentTypesContent, relationshipDocuments, workbookFound, worksheetPaths);
        resolve();
      } catch (error) {
        reject(error instanceof ParticipantImportFileError ? error : new ParticipantImportFileError("IMPORT_FILE_INVALID"));
      }
    });
    zip.once("error", () => fail(new ParticipantImportFileError("IMPORT_FILE_INVALID")));
    zip.readEntry();
  });
};

const parseXlsx = async (bytes: Uint8Array, limits: ParticipantImportParserLimits): Promise<readonly RawParticipantImportRow[]> => {
  await inspectXlsxArchive(bytes, limits);
  let excelJsBytes: Buffer;
  try {
    excelJsBytes = await normalizeXlsxForExcelJs(bytes);
  } catch (error) {
    throw new ParticipantImportFileError("IMPORT_FILE_INVALID", { cause: xlsxDeveloperCause("namespace-normalization", error) });
  }
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(excelJsBytes as unknown as Parameters<typeof workbook.xlsx.load>[0], {
      ignoreNodes: ["dataValidations", "extLst", "drawing", "picture", "tableParts"]
    });
  } catch (error) {
    throw new ParticipantImportFileError("IMPORT_FILE_INVALID", { cause: xlsxDeveloperCause("exceljs-load", error) });
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
