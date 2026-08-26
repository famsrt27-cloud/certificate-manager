import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { parseParticipantImport } from "./participant-import-parser.js";
import type { ParticipantImportFileError } from "./participant-import-parser.js";

const xlsxMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const limits = { maximumRows: 10, maximumUncompressedBytes: 1_000_000 };

interface ZipEntryInput {
  readonly name: string;
  readonly body?: string | Uint8Array;
  readonly encrypted?: boolean;
  readonly declaredUncompressedSize?: number;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

const crc32 = (bytes: Uint8Array): number => {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

const syntheticZip = (entries: readonly ZipEntryInput[]): Buffer => {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const body = typeof entry.body === "string" ? Buffer.from(entry.body) : Buffer.from(entry.body ?? "");
    const flags = entry.encrypted === true ? 1 : 0;
    const uncompressedSize = entry.declaredUncompressedSize ?? body.byteLength;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt32LE(crc32(body), 14);
    local.writeUInt32LE(body.byteLength, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.byteLength, 26);
    localParts.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt32LE(crc32(body), 16);
    central.writeUInt32LE(body.byteLength, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.byteLength + name.byteLength + body.byteLength;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
};

const minimalEntries = (extra: readonly ZipEntryInput[] = []): readonly ZipEntryInput[] => [
  { name: "[Content_Types].xml", body: "<Types/>" },
  { name: "xl/workbook.xml", body: "<workbook/>" },
  { name: "xl/worksheets/sheet1.xml", body: "<worksheet/>" },
  ...extra
];

const expectCode = async (bytes: Uint8Array, mime: string, code: ParticipantImportFileError["code"], customLimits = limits) => {
  await expect(parseParticipantImport(bytes, mime, customLimits)).rejects.toMatchObject({ code });
};

const workbookBytes = async (rows: readonly unknown[][], configure?: (sheet: ExcelJS.Worksheet) => void): Promise<Uint8Array> => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Participants");
  for (const row of rows) sheet.addRow(row);
  configure?.(sheet);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
};

describe("participant import parser", () => {
  it("parses approved CSV literals, line endings, and spreadsheet-looking text without formula interpretation", async () => {
    const rows = await parseParticipantImport(Buffer.from(
      "display_name,external_reference\r\n\"Line 1\rLine 2\",=literal\r\n\"Line A\nLine B\",+literal\r\n-safe,@literal\r\n"
    ), "text/csv", limits);
    expect(rows.map((row) => row.displayName)).toEqual(["Line 1\rLine 2", "Line A\nLine B", "-safe"]);
    expect(rows.map((row) => row.externalReference)).toEqual(["=literal", "+literal", "@literal"]);
    expect(rows.every((row) => row.status === "VALID")).toBe(true);
  });

  it.each([
    [Buffer.alloc(0), "IMPORT_SCHEMA_INVALID"],
    [Buffer.from([0xef, 0xbb, 0xbf]), "IMPORT_SCHEMA_INVALID"],
    [Buffer.from([0xff, 0xfe]), "IMPORT_FILE_INVALID"],
    [Buffer.from("display_name\n\"unclosed"), "IMPORT_FILE_INVALID"],
    [Buffer.from("display_name\n\"a\"b"), "IMPORT_FILE_INVALID"],
    [Buffer.from("display_name\0\nPerson"), "IMPORT_FILE_INVALID"],
    [Buffer.from("display_name,external_reference,extra\nPerson,REF,x"), "IMPORT_SCHEMA_INVALID"],
    [Buffer.from("display_name,display_name\nPerson,Other"), "IMPORT_SCHEMA_INVALID"],
    [Buffer.from("external_reference\nREF"), "IMPORT_SCHEMA_INVALID"],
    [Buffer.from("display_name,unknown\nPerson,value"), "IMPORT_SCHEMA_INVALID"],
    [Buffer.from("display_name\n"), "IMPORT_EMPTY"],
    [Buffer.from(`display_name\n${"a".repeat(4_097)}`), "IMPORT_LIMIT_EXCEEDED"]
  ] as const)("rejects a bounded malicious CSV corpus", async (bytes, code) => {
    await expectCode(bytes, "text/csv", code);
  });

  it("enforces the CSV row boundary during parsing and keeps field validation bounded", async () => {
    const exact = Buffer.from(`display_name\n${Array.from({ length: 10 }, (_, index) => `Person ${index}`).join("\n")}`);
    await expect(parseParticipantImport(exact, "text/csv", limits)).resolves.toHaveLength(10);
    await expectCode(Buffer.concat([exact, Buffer.from("\nOne too many")]), "text/csv", "IMPORT_LIMIT_EXCEEDED");
    const rows = await parseParticipantImport(Buffer.from(`display_name\n${"x".repeat(201)}`), "text/csv", limits);
    expect(rows[0]?.validationErrors).toContainEqual({ code: "DISPLAY_NAME_TOO_LONG", field: "display_name" });
  });

  it.each([
    [Buffer.from("not a zip"), "IMPORT_FILE_INVALID"],
    [Buffer.from([0x50, 0x4b, 0x03, 0x04]), "IMPORT_FILE_INVALID"],
    [syntheticZip([{ name: "[Content_Types].xml" }]), "IMPORT_FILE_INVALID"],
    [syntheticZip([{ name: "xl/workbook.xml" }]), "IMPORT_FILE_INVALID"],
    [syntheticZip(minimalEntries([{ name: "xl/worksheets/sheet2.xml", body: "<worksheet/>" }])), "IMPORT_FILE_INVALID"],
    [syntheticZip(minimalEntries([{ name: "xl/workbook.xml", body: "duplicate" }])), "IMPORT_LIMIT_EXCEEDED"],
    [syntheticZip(minimalEntries([{ name: "../escape.xml" }])), "IMPORT_FILE_INVALID"],
    [syntheticZip(minimalEntries([{ name: "xl/../escape.xml" }])), "IMPORT_FILE_INVALID"],
    [syntheticZip(minimalEntries([{ name: "xl\\..\\escape.xml" }])), "IMPORT_FILE_INVALID"],
    [syntheticZip(minimalEntries([{ name: "/absolute.xml" }])), "IMPORT_FILE_INVALID"],
    [syntheticZip(minimalEntries([{ name: "C:\\Windows\\file.xml" }])), "IMPORT_FILE_INVALID"],
    [syntheticZip(minimalEntries([{ name: "encrypted.bin", encrypted: true }])), "IMPORT_FILE_INVALID"]
  ] as const)("rejects malformed, ambiguous, encrypted, or traversal ZIP structures", async (bytes, code) => {
    await expectCode(bytes, xlsxMime, code);
  });

  it("enforces ZIP entry, individual, and cumulative uncompressed limits without expanding large fixtures", async () => {
    const tooMany = syntheticZip([...minimalEntries(), ...Array.from({ length: 998 }, (_, index) => ({ name: `safe/${index}.xml` }))]);
    await expectCode(tooMany, xlsxMime, "IMPORT_LIMIT_EXCEEDED");
    await expectCode(syntheticZip(minimalEntries([{ name: "large.xml", body: "x".repeat(101) }])), xlsxMime,
      "IMPORT_LIMIT_EXCEEDED", { ...limits, maximumUncompressedBytes: 100 });
    await expectCode(syntheticZip(minimalEntries([{ name: "a.xml", body: "12345" }, { name: "b.xml", body: "67890" }])), xlsxMime,
      "IMPORT_LIMIT_EXCEEDED", { ...limits, maximumUncompressedBytes: 40 });
  });

  it.each([
    [{ name: "xl/externalLinks/externalLink1.xml" }, "external link part"],
    [{ name: "xl/embeddings/object.bin" }, "embedded part"],
    [{ name: "xl/oleObjects/oleObject1.bin" }, "OLE part"],
    [{ name: "xl/vbaProject.bin" }, "macro part"],
    [{ name: "xl/_rels/workbook.xml.rels", body: "<Relationships><Relationship TargetMode=\"External\" Target=\"http://127.0.0.1/\"/></Relationships>" }, "external relationship"],
    [{ name: "xl/_rels/utf16.xml.rels", body: Buffer.concat([Buffer.from([0xff, 0xfe]),
      Buffer.from("<Relationship TargetMode=\"&#x45;xternal\" Target=\"http://localhost/\"/>", "utf16le")]) }, "encoded UTF-16 external relationship"],
    [{ name: "xl/worksheets/_rels/sheet1.xml.rels", body: "<Relationship Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink\" Target=\"file:///secret\" TargetMode=\"External\"/>" }, "external hyperlink"],
    [{ name: "[Content_Types].xml", body: "<Types><Override ContentType=\"application/vnd.ms-office.vbaProject\"/></Types>" }, "macro content type"]
  ] as const)("rejects hostile OOXML content", async (entry, label) => {
    expect(label).toBeTypeOf("string");
    const entries = entry.name === "[Content_Types].xml"
      ? [{ ...minimalEntries()[0]!, ...entry }, ...minimalEntries().slice(1)]
      : minimalEntries([entry]);
    await expectCode(syntheticZip(entries), xlsxMime, "IMPORT_FILE_INVALID");
  });

  it("rejects formula and object cell values without coercing them into participant fields", async () => {
    const bytes = await workbookBytes([
      ["display_name", "external_reference"],
      [{ formula: "1+1", result: 2 }, "FORMULA"],
      [{ sharedFormula: "A2", result: 2 }, "SHARED"],
      [{ richText: [{ text: "Rich" }] }, "RICH"],
      [new Date("2026-01-01T00:00:00Z"), "DATE"],
      [{ error: "#VALUE!" }, "ERROR"],
      ["Plain UTF-8 ผู้รับ", "PLAIN"]
    ]);
    const rows = await parseParticipantImport(bytes, xlsxMime, limits);
    expect(rows.slice(0, 5).every((row) => row.validationErrors.some((issue) => issue.code === "UNSUPPORTED_CELL_VALUE"))).toBe(true);
    expect(rows[5]).toMatchObject({ displayName: "Plain UTF-8 ผู้รับ", externalReference: "PLAIN", status: "VALID" });
    await expectCode(await workbookBytes([["display_name"], [{ text: "Remote", hyperlink: "https://127.0.0.1/" }]]),
      xlsxMime, "IMPORT_FILE_INVALID");
  });

  it.each([
    [["display_name", "display_name"], ["A", "B"]],
    [["display_name", ""], ["A", "hidden"]],
    [["display_name", "external_reference", "extra"], ["A", "REF", "hidden"]],
    [["external_reference"], ["REF"]]
  ])("rejects ambiguous XLSX columns", async (...rows) => {
    await expectCode(await workbookBytes(rows), xlsxMime, "IMPORT_SCHEMA_INVALID");
  });

  it("supports reordered columns and blank rows but rejects only-header and sparse over-limit rows", async () => {
    const reordered = await workbookBytes([["external_reference", "display_name"], ["REF", "Person"], [], ["REF-2", "Person 2"]]);
    await expect(parseParticipantImport(reordered, xlsxMime, limits)).resolves.toMatchObject([
      { displayName: "Person", externalReference: "REF" }, { displayName: "Person 2", externalReference: "REF-2" }
    ]);
    await expectCode(await workbookBytes([["display_name"]]), xlsxMime, "IMPORT_EMPTY");
    const sparse = await workbookBytes([["display_name"]], (sheet) => { sheet.getCell(limits.maximumRows + 2, 1).value = "Too far"; });
    await expectCode(sparse, xlsxMime, "IMPORT_LIMIT_EXCEEDED");
  });
});
