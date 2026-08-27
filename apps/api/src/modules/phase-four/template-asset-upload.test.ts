import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { validateTemplateAssetUpload } from "./template-asset-upload.js";

const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

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

const pngWithDimensions = (width: number, height: number): Buffer => {
  const bytes = Buffer.from(onePixelPng);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
  return bytes;
};

const pngWithAnimatedMarker = (): Buffer => {
  const chunk = Buffer.alloc(20);
  chunk.writeUInt32BE(8, 0);
  chunk.write("acTL", 4, "latin1");
  chunk.writeUInt32BE(2, 8);
  chunk.writeUInt32BE(0, 12);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 16)), 16);
  return Buffer.concat([onePixelPng.subarray(0, 33), chunk, onePixelPng.subarray(33)]);
};

interface SfntTable { readonly tag: string; readonly offset?: number; readonly length?: number }

const sfnt = (tables: readonly SfntTable[], signature: "TTF" | "OTF" = "TTF", byteLength?: number): Buffer => {
  const directoryEnd = 12 + tables.length * 16;
  const total = byteLength ?? directoryEnd + tables.length;
  const bytes = Buffer.alloc(Math.max(total, 12));
  if (signature === "OTF") bytes.write("OTTO", 0, "latin1");
  else bytes.set([0, 1, 0, 0], 0);
  bytes.writeUInt16BE(tables.length, 4);
  tables.forEach((table, index) => {
    const directoryOffset = 12 + index * 16;
    bytes.write(table.tag, directoryOffset, 4, "latin1");
    bytes.writeUInt32BE(table.offset ?? directoryEnd + index, directoryOffset + 8);
    bytes.writeUInt32BE(table.length ?? 1, directoryOffset + 12);
  });
  return bytes;
};

const requiredTables: readonly SfntTable[] = [{ tag: "head" }, { tag: "name" }, { tag: "maxp" }];

describe("validateTemplateAssetUpload", () => {
  it("accepts canonical PNG/JPEG signatures and normalizes attacker-controlled filenames for display only", async () => {
    const jpeg = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).jpeg().toBuffer();
    await expect(validateTemplateAssetUpload({ filename: "../../logo.png", declaredMimeType: "image/png", bytes: onePixelPng }))
      .resolves.toMatchObject({ originalFilename: "logo.png", detectedMimeType: "image/png", widthPx: 1, heightPx: 1 });
    await expect(validateTemplateAssetUpload({ filename: "C:\\Windows\\photo.jpeg", declaredMimeType: "image/jpeg", bytes: jpeg }))
      .resolves.toMatchObject({ originalFilename: "photo.jpg", detectedMimeType: "image/jpeg", widthPx: 1, heightPx: 1 });
  });

  it.each([
    ["image/png", Buffer.from("MZ inert executable marker")],
    ["image/png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
    ["image/png", onePixelPng.subarray(0, onePixelPng.byteLength - 8)],
    ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff])],
    ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0x00])],
    ["image/jpeg", onePixelPng],
    ["image/svg+xml", Buffer.from("<svg><script>inert</script></svg>")],
    ["image/gif", Buffer.from("GIF89a")],
    ["image/webp", Buffer.from("RIFFxxxxWEBP")],
    ["image/tiff", Buffer.from("II*\\0")],
    ["application/pdf", Buffer.from("%PDF-inert")]
  ])("rejects malformed, mismatched, or unsupported image content", async (declaredMimeType, bytes) => {
    await expect(validateTemplateAssetUpload({ filename: "asset", declaredMimeType, bytes }))
      .rejects.toMatchObject({ code: "UPLOAD_REJECTED" });
  });

  it("rejects a compact malformed animated PNG marker but tolerates inert trailing bytes that no downstream code executes", async () => {
    await expect(validateTemplateAssetUpload({ filename: "animated.png", declaredMimeType: "image/png", bytes: pngWithAnimatedMarker() }))
      .rejects.toMatchObject({ code: "UPLOAD_REJECTED" });
    await expect(validateTemplateAssetUpload({ filename: "trailing.png", declaredMimeType: "image/png",
      bytes: Buffer.concat([onePixelPng, Buffer.from("inert trailing marker")]) }))
      .resolves.toMatchObject({ detectedMimeType: "image/png", widthPx: 1, heightPx: 1 });
  });

  it("enforces image dimension and pixel budgets from compact metadata", async () => {
    await expect(validateTemplateAssetUpload({ filename: "wide.png", declaredMimeType: "image/png", bytes: pngWithDimensions(4_097, 1) }))
      .rejects.toMatchObject({ code: "UPLOAD_REJECTED" });
    await expect(validateTemplateAssetUpload({ filename: "pixels.png", declaredMimeType: "image/png", bytes: pngWithDimensions(4_096, 4_096) }))
      .rejects.toMatchObject({ code: "UPLOAD_REJECTED" });
  });

  it.each([
    ["font/woff", Buffer.from("wOFF")],
    ["font/woff2", Buffer.from("wOF2")],
    ["font/ttf", Buffer.from("ttcf")],
    ["font/ttf", Buffer.from("random")],
    ["font/ttf", Buffer.from([0, 1, 0, 0])],
    ["font/otf", sfnt(requiredTables, "TTF")],
    ["font/ttf", sfnt(requiredTables, "OTF")]
  ])("rejects unsupported, truncated, or MIME-confused font content", async (declaredMimeType, bytes) => {
    await expect(validateTemplateAssetUpload({ filename: "font.bin", declaredMimeType, bytes }))
      .rejects.toMatchObject({ code: "UPLOAD_REJECTED" });
  });

  it.each([
    [sfnt([], "TTF"), "zero tables"],
    [sfnt(Array.from({ length: 129 }, (_, index) => ({ tag: `A${String(index).padStart(3, "0")}`.slice(0, 4) }))), "excess tables"],
    [sfnt([{ tag: "head" }, { tag: "head" }, { tag: "maxp" }]), "duplicate tags"],
    [sfnt([{ tag: "he\0d" }, { tag: "name" }, { tag: "maxp" }]), "non-printable tag"],
    [sfnt([{ tag: "head", length: 0 }, { tag: "name" }, { tag: "maxp" }]), "zero table"],
    [sfnt([{ tag: "head", offset: 0xffffffff }, { tag: "name" }, { tag: "maxp" }]), "offset overflow"],
    [sfnt([{ tag: "head", length: 0xffffffff }, { tag: "name" }, { tag: "maxp" }]), "length overflow"],
    [sfnt([{ tag: "head" }, { tag: "name" }]), "missing maxp"],
    [sfnt([{ tag: "head" }, { tag: "maxp" }]), "missing name"],
    [sfnt([{ tag: "name" }, { tag: "maxp" }]), "missing head"]
  ])("rejects malformed SFNT table directories", async (bytes) => {
    await expect(validateTemplateAssetUpload({ filename: "font.ttf", declaredMimeType: "font/ttf", bytes }))
      .rejects.toMatchObject({ code: "UPLOAD_REJECTED" });
  });

  it("allows a bounded structurally passing SFNT to reach the renderer's controlled parser boundary", async () => {
    const overlapping = sfnt(requiredTables.map((table) => ({ ...table, offset: 60 })), "TTF", 61);
    await expect(validateTemplateAssetUpload({ filename: "synthetic.ttf", declaredMimeType: "font/ttf", bytes: overlapping }))
      .resolves.toMatchObject({ detectedMimeType: "font/ttf", widthPx: null, heightPx: null });
  });

  it.each([
    "../asset.png", "..\\asset.png", "/absolute/path.png", "C:\\Windows\\asset.png", "\\\\server\\share\\asset.png",
    "...hidden..png", "e\u0301.png", ".leading.png", "trailing. .png", "control\u0001.png", `${"x".repeat(300)}.png`, "photo.jpg.exe"
  ])("normalizes path-like filenames without retaining path separators", async (filename) => {
    const result = await validateTemplateAssetUpload({ filename, declaredMimeType: "image/png", bytes: onePixelPng });
    expect(result.originalFilename).toMatch(/^[A-Za-z0-9_-][A-Za-z0-9._-]*\.png$/);
    expect(result.originalFilename.length).toBeLessThanOrEqual(194);
  });
});
