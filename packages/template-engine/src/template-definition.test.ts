import { describe, expect, it } from "vitest";

import { TemplateDefinitionSchema, collectTemplateAssetIds, collectTemplateAssetRequirements } from "./template-definition.js";

const validDefinition = {
  format_version: 1,
  page: { width: 1123, height: 794, unit: "px" },
  elements: [{ type: "text", x: 100, y: 100, width: 800, height: 80, align: "center",
    font: { family: "Noto Sans Thai", size: 42, weight: 700 }, binding: "recipient.display_name" }]
};

describe("TemplateDefinitionSchema", () => {
  it("normalizes a valid versioned definition", () => {
    expect(TemplateDefinitionSchema.parse(validDefinition).elements[0]).toMatchObject({ opacity: 1, color: "#000000" });
  });

  it.each([
    [{ ...validDefinition, script: "alert(1)" }],
    [{ ...validDefinition, elements: [{ ...validDefinition.elements[0], binding: "recipient.__proto__.secret" }] }],
    [{ ...validDefinition, elements: [{ ...validDefinition.elements[0], x: Number.NaN }] }],
    [{ ...validDefinition, elements: [{ ...validDefinition.elements[0], x: 1000, width: 800 }] }],
    [{ ...validDefinition, elements: [{ type: "image", asset_id: "../../etc/passwd" }] }]
  ])("rejects malicious or out-of-contract input", (input) => {
    expect(TemplateDefinitionSchema.safeParse(input).success).toBe(false);
  });

  it("collects a stable de-duplicated asset set", () => {
    const id = "3d813cbb-47fb-4196-9f8b-e5b6f3b4af83";
    const definition = TemplateDefinitionSchema.parse({ ...validDefinition, elements: [
      { type: "image", asset_id: id, x: 0, y: 0, width: 10, height: 10 },
      { type: "signature", asset_id: id, x: 20, y: 20, width: 10, height: 10 }
    ] });
    expect(collectTemplateAssetIds(definition)).toEqual([id]);
  });

  it("requires private asset references for unbundled fonts and records their purpose", () => {
    const id = "3d813cbb-47fb-4196-9f8b-e5b6f3b4af83";
    expect(TemplateDefinitionSchema.safeParse({ ...validDefinition, elements: [{ ...validDefinition.elements[0],
      font: { family: "Remote Font", size: 42 } }] }).success).toBe(false);
    const definition = TemplateDefinitionSchema.parse({ ...validDefinition, elements: [{ ...validDefinition.elements[0],
      font: { family: "Private Font", asset_id: id, size: 42 } }] });
    expect(collectTemplateAssetRequirements(definition)).toEqual([{ id, kind: "FONT" }]);
  });
});
