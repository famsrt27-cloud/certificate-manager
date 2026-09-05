import { describe, expect, it } from "vitest";

import { TemplateDefinitionSchema, remapTemplateAssetIds } from "./template-definition.js";

const imageId = "00000000-0000-4000-8000-000000000001";
const signatureId = "00000000-0000-4000-8000-000000000002";
const fontId = "00000000-0000-4000-8000-000000000003";
const newImageId = "00000000-0000-4000-8000-000000000011";
const newSignatureId = "00000000-0000-4000-8000-000000000012";
const newFontId = "00000000-0000-4000-8000-000000000013";

const definition = TemplateDefinitionSchema.parse({
  format_version: 1,
  page: { width: 800, height: 600, unit: "px" },
  elements: [
    { type: "image", asset_id: imageId, x: 0, y: 0, width: 100, height: 100 },
    { type: "image", asset_id: imageId, x: 100, y: 0, width: 100, height: 100 },
    { type: "signature", asset_id: signatureId, x: 0, y: 100, width: 100, height: 50 },
    { type: "text", text: `literal ${imageId}`, x: 0, y: 200, width: 300, height: 50,
      font: { family: "Private font", asset_id: fontId, size: 20 } },
    { type: "text", binding: "recipient.display_name", x: 0, y: 250, width: 300, height: 50,
      font: { family: "Noto Sans Thai", size: 20 } },
    { type: "qr", binding: "verification_url", x: 0, y: 300, width: 100, height: 100 }
  ]
});

describe("remapTemplateAssetIds", () => {
  const remap = () => remapTemplateAssetIds(definition, new Map([
      [imageId, newImageId], [signatureId, newSignatureId], [fontId, newFontId]
    ]));

  it("remaps an image asset ID", () => {
    expect(remap().elements[0]).toMatchObject({ type: "image", asset_id: newImageId });
  });

  it("remaps a signature asset ID", () => {
    expect(remap().elements[2]).toMatchObject({ type: "signature", asset_id: newSignatureId });
  });

  it("remaps a custom-font asset ID", () => {
    expect(remap().elements[3]).toMatchObject({ type: "text",
      font: expect.objectContaining({ asset_id: newFontId }) });
  });

  it("maps repeated references to the same destination asset", () => {
    expect(remap().elements.slice(0, 2)).toEqual([
      expect.objectContaining({ asset_id: newImageId }), expect.objectContaining({ asset_id: newImageId })
    ]);
  });

  it("fails closed when any referenced asset has no exact mapping", () => {
    expect(() => remapTemplateAssetIds(definition, new Map([[imageId, newImageId]])))
      .toThrow("Template asset mapping is incomplete");
  });

  it("does not rewrite literal text, bindings, or unrelated elements", () => {
    const remapped = remap();
    expect(remapped.elements[3]).toMatchObject({ text: `literal ${imageId}` });
    expect(remapped.elements[4]).toMatchObject({ type: "text", binding: "recipient.display_name" });
    expect(remapped.elements[5]).toMatchObject({ type: "qr", binding: "verification_url" });
  });

  it("returns a definition accepted by the canonical schema", () => {
    expect(TemplateDefinitionSchema.safeParse(remap()).success).toBe(true);
  });
});
