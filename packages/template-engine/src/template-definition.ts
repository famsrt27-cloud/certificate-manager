import { z } from "zod";

export const TEMPLATE_FORMAT_VERSION = 1 as const;
export const TEMPLATE_BINDINGS = [
  "recipient.display_name",
  "project.name",
  "training.name",
  "training.code",
  "certificate.number",
  "certificate.issued_at",
  "verification_url"
] as const;

export const TemplateBindingSchema = z.enum(TEMPLATE_BINDINGS);
const FiniteNumberSchema = z.number().finite();
const CoordinateSchema = FiniteNumberSchema.min(0).max(5_000);
const DimensionSchema = FiniteNumberSchema.positive().max(5_000);
const OpacitySchema = FiniteNumberSchema.min(0).max(1).default(1);
const ColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/).transform((value) => value.toUpperCase());
const AssetIdSchema = z.uuid();
const containsForbiddenControlCharacter = (value: string): boolean => [...value].some((character) => {
  const code = character.codePointAt(0) ?? 0;
  return code === 127 || (code < 32 && code !== 9 && code !== 10);
});
const SafeLiteralSchema = z.string().max(2_000).refine((value) => !containsForbiddenControlCharacter(value), {
  message: "control characters are not allowed"
});
const hasUnsafePrototypeKey = (input: unknown): boolean => {
  const pending: unknown[] = [input];
  let visited = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object") continue;
    visited += 1;
    if (visited > 5_000) return true;
    for (const key of Object.keys(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") return true;
      pending.push((value as Record<string, unknown>)[key]);
    }
  }
  return false;
};

const PlacementFields = {
  x: CoordinateSchema.default(0),
  y: CoordinateSchema.default(0),
  width: DimensionSchema.default(100),
  height: DimensionSchema.default(40),
  opacity: OpacitySchema
};

const TextElementSchema = z.object({
  type: z.literal("text"),
  ...PlacementFields,
  text: SafeLiteralSchema.optional(),
  binding: TemplateBindingSchema.optional(),
  align: z.enum(["left", "center", "right"]).default("left"),
  color: ColorSchema.default("#000000"),
  font: z.object({
    family: z.string().trim().min(1).max(100),
    asset_id: AssetIdSchema.optional(),
    size: FiniteNumberSchema.min(6).max(200),
    weight: z.union([z.literal(400), z.literal(700)]).default(400)
  }).strict().refine((font) => font.asset_id !== undefined || font.family === "Noto Sans Thai" || font.family === "Noto Serif Thai", {
    message: "unbundled fonts require a validated asset_id"
  })
}).strict().refine((element) => (element.text === undefined) !== (element.binding === undefined), {
  message: "text elements require exactly one of text or binding"
});

const ImageElementSchema = z.object({
  type: z.literal("image"),
  ...PlacementFields,
  asset_id: AssetIdSchema,
  fit: z.enum(["contain", "cover", "fill"]).default("contain")
}).strict();

const SignatureElementSchema = z.object({
  type: z.literal("signature"),
  ...PlacementFields,
  asset_id: AssetIdSchema
}).strict();

const QrElementSchema = z.object({
  type: z.literal("qr"),
  ...PlacementFields,
  binding: z.literal("verification_url"),
  foreground: ColorSchema.default("#000000"),
  background: ColorSchema.default("#FFFFFF")
}).strict();

const ShapeElementSchema = z.object({
  type: z.literal("shape"),
  ...PlacementFields,
  shape: z.enum(["line", "rectangle"]),
  color: ColorSchema,
  stroke_width: FiniteNumberSchema.min(0.5).max(20).default(1)
}).strict();

export const TemplateElementSchema = z.union([
  TextElementSchema,
  ImageElementSchema,
  SignatureElementSchema,
  QrElementSchema,
  ShapeElementSchema
]);

const TemplateDefinitionObjectSchema = z.object({
  format_version: z.literal(TEMPLATE_FORMAT_VERSION),
  page: z.object({
    width: DimensionSchema.min(100),
    height: DimensionSchema.min(100),
    unit: z.literal("px")
  }).strict(),
  elements: z.array(TemplateElementSchema).max(200)
}).strict().superRefine((definition, context) => {
  const assetKinds = new Map<string, "IMAGE" | "FONT">();
  definition.elements.forEach((element, index) => {
    if (element.x + element.width > definition.page.width) {
      context.addIssue({ code: "custom", path: ["elements", index, "width"], message: "element exceeds page width" });
    }
    if (element.y + element.height > definition.page.height) {
      context.addIssue({ code: "custom", path: ["elements", index, "height"], message: "element exceeds page height" });
    }
    const asset = element.type === "image" || element.type === "signature" ? { id: element.asset_id, kind: "IMAGE" as const }
      : element.type === "text" && element.font.asset_id !== undefined ? { id: element.font.asset_id, kind: "FONT" as const } : undefined;
    if (asset !== undefined) {
      const prior = assetKinds.get(asset.id);
      if (prior !== undefined && prior !== asset.kind) {
        context.addIssue({ code: "custom", path: ["elements", index], message: "one asset cannot be used as both image and font" });
      }
      assetKinds.set(asset.id, asset.kind);
    }
  });
});

export const TemplateDefinitionSchema = z.preprocess(
  (input) => hasUnsafePrototypeKey(input) ? null : input,
  TemplateDefinitionObjectSchema
);

export type TemplateBinding = z.infer<typeof TemplateBindingSchema>;
export type TemplateElement = z.infer<typeof TemplateElementSchema>;
export type TemplateDefinition = z.infer<typeof TemplateDefinitionSchema>;

export interface TemplateAssetRequirement { readonly id: string; readonly kind: "IMAGE" | "FONT" }

export const collectTemplateAssetRequirements = (definition: TemplateDefinition): readonly TemplateAssetRequirement[] => {
  const requirements = new Map<string, "IMAGE" | "FONT">();
  for (const element of definition.elements) {
    if (element.type === "image" || element.type === "signature") requirements.set(element.asset_id, "IMAGE");
    if (element.type === "text" && element.font.asset_id !== undefined) requirements.set(element.font.asset_id, "FONT");
  }
  return [...requirements].map(([id, kind]) => ({ id, kind })).sort((left, right) => left.id.localeCompare(right.id));
};

export const collectTemplateAssetIds = (definition: TemplateDefinition): readonly string[] =>
  collectTemplateAssetRequirements(definition).map((requirement) => requirement.id);

export const remapTemplateAssetIds = (
  definition: TemplateDefinition,
  assetIdMapping: ReadonlyMap<string, string>
): TemplateDefinition => {
  const remap = (sourceId: string): string => {
    const destinationId = assetIdMapping.get(sourceId);
    if (destinationId === undefined) throw new Error("Template asset mapping is incomplete");
    return destinationId;
  };
  const remapped = {
    ...definition,
    page: { ...definition.page },
    elements: definition.elements.map((element) => {
      if (element.type === "image" || element.type === "signature") {
        return { ...element, asset_id: remap(element.asset_id) };
      }
      if (element.type === "text") {
        return { ...element, font: element.font.asset_id === undefined
          ? { ...element.font }
          : { ...element.font, asset_id: remap(element.font.asset_id) } };
      }
      return { ...element };
    })
  };
  return TemplateDefinitionSchema.parse(remapped);
};
