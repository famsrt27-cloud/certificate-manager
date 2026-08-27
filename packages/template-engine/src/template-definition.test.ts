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

  it.each([
    ["wrong format version", { ...validDefinition, format_version: 2 }],
    ["unknown page field", { ...validDefinition, page: { ...validDefinition.page, url: "http://127.0.0.1" } }],
    ["unknown element field", { ...validDefinition, elements: [{ ...validDefinition.elements[0], onclick: "inert" }] }],
    ["unknown font field", { ...validDefinition, elements: [{ ...validDefinition.elements[0], font: { ...validDefinition.elements[0]!.font, src: "file:///secret" } }] }],
    ["unknown element type", { ...validDefinition, elements: [{ type: "script" }] }],
    ["infinite coordinate", { ...validDefinition, elements: [{ ...validDefinition.elements[0], x: Number.POSITIVE_INFINITY }] }],
    ["negative coordinate", { ...validDefinition, elements: [{ ...validDefinition.elements[0], x: -1 }] }],
    ["out-of-range coordinate", { ...validDefinition, elements: [{ ...validDefinition.elements[0], x: 5_001 }] }],
    ["zero dimension", { ...validDefinition, elements: [{ ...validDefinition.elements[0], width: 0 }] }],
    ["negative dimension", { ...validDefinition, elements: [{ ...validDefinition.elements[0], height: -1 }] }],
    ["oversized page", { ...validDefinition, page: { ...validDefinition.page, width: 5_001 } }],
    ["invalid opacity", { ...validDefinition, elements: [{ ...validDefinition.elements[0], opacity: 1.01 }] }],
    ["invalid color", { ...validDefinition, elements: [{ ...validDefinition.elements[0], color: "javascript:inert" }] }],
    ["invalid asset UUID", { ...validDefinition, elements: [{ type: "image", asset_id: "http://localhost/image.png" }] }],
    ["too many elements", { ...validDefinition, elements: Array.from({ length: 201 }, () => validDefinition.elements[0]) }],
    ["element outside page height", { ...validDefinition, elements: [{ ...validDefinition.elements[0], y: 790, height: 80 }] }]
  ])("rejects strict schema violation: %s", (_name, input) => {
    expect(TemplateDefinitionSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    "constructor", "prototype", "__proto__", "recipient.__proto__", "recipient.constructor", "process.env", "globalThis",
    "require", "fs", "../../secret", "recipient.arbitrary.path", "{{recipient.display_name}}", "recipient.display_name + process.env.SECRET"
  ])("rejects non-allowlisted binding %s", (binding) => {
    expect(TemplateDefinitionSchema.safeParse({ ...validDefinition,
      elements: [{ ...validDefinition.elements[0], binding }] }).success).toBe(false);
  });

  it("rejects prototype keys at nested positions without modifying Object.prototype", () => {
    const sentinel = "phase7Polluted";
    expect((Object.prototype as Record<string, unknown>)[sentinel]).toBeUndefined();
    const inputs = [
      JSON.parse(`{"format_version":1,"page":{"width":500,"height":500,"unit":"px"},"elements":[],"__proto__":{"${sentinel}":true}}`),
      JSON.parse(`{"format_version":1,"page":{"width":500,"height":500,"unit":"px","constructor":{}},"elements":[]}`),
      JSON.parse(`{"format_version":1,"page":{"width":500,"height":500,"unit":"px"},"elements":[{"type":"text","text":"literal","font":{"family":"Noto Sans Thai","size":24,"prototype":{}}}]}`)
    ];
    for (const input of inputs) expect(TemplateDefinitionSchema.safeParse(input).success).toBe(false);
    expect((Object.prototype as Record<string, unknown>)[sentinel]).toBeUndefined();
  });

  it.each([
    "<script>alert(1)</script>", "<img src=x onerror=inert>", "{{constructor.constructor('inert')()}}",
    "${process.env.SECRET}", "<%= inert %>", "javascript:inert", "file:///etc/passwd", "../../../../etc/passwd"
  ])("preserves suspicious text as bounded literal data", (text) => {
    const parsed = TemplateDefinitionSchema.parse({ ...validDefinition,
      elements: [{ ...validDefinition.elements[0], binding: undefined, text }] });
    expect(parsed.elements[0]).toMatchObject({ type: "text", text });
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
