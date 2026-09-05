import { describe, expect, it } from "vitest";

import { CreateTemplateVersionRequestSchema, DuplicateTemplateRequestSchema, TemplateAssetSchema } from "./phase-four.js";

describe("Phase 4 wire contracts", () => {
  it("validates normalized custom JSON definitions", () => {
    const result = CreateTemplateVersionRequestSchema.parse({ definition: {
      format_version: 1, page: { width: 500, height: 300, unit: "px" }, elements: []
    } });
    expect(result.definition.format_version).toBe(1);
  });

  it("does not expose storage keys in asset responses", () => {
    expect(TemplateAssetSchema.safeParse({
      id: "32807741-2a79-44b0-9049-3f500fd37ce0", template_id: "be70f9ef-2eb2-486e-88a9-cbc717e1da14",
      original_filename: "logo.png", detected_mime_type: "image/png", content_sha256: "a".repeat(64),
      size_bytes: 10, width_px: 1, height_px: 1, status: "ACTIVE", storage_key: "private/key"
    }).success).toBe(true);
  });

  it("accepts only a source version and validated destination name for duplication", () => {
    const input = { source_version_id: "32807741-2a79-44b0-9049-3f500fd37ce0", name: "Independent" };
    expect(DuplicateTemplateRequestSchema.parse(input)).toEqual(input);
    expect(DuplicateTemplateRequestSchema.safeParse({ ...input, definition: {} }).success).toBe(false);
    expect(DuplicateTemplateRequestSchema.safeParse({ ...input, asset_ids: [] }).success).toBe(false);
    expect(DuplicateTemplateRequestSchema.safeParse({ ...input, storage_key: "private/key" }).success).toBe(false);
  });
});
