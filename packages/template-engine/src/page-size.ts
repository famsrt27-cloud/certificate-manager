export const CSS_PIXELS_PER_INCH = 96;
export const PDF_POINTS_PER_INCH = 72;
export const MILLIMETERS_PER_INCH = 25.4;

export type PagePresetId = "A4" | "A5" | "B5_ISO" | "B5_JIS" | "CUSTOM";
export type PageOrientation = "PORTRAIT" | "LANDSCAPE";

export interface PagePreset {
  readonly id: Exclude<PagePresetId, "CUSTOM">;
  readonly label: string;
  readonly widthMm: number;
  readonly heightMm: number;
}

export const PAGE_PRESETS: readonly PagePreset[] = [
  { id: "A4", label: "A4", widthMm: 210, heightMm: 297 },
  { id: "A5", label: "A5", widthMm: 148, heightMm: 210 },
  { id: "B5_ISO", label: "B5 ISO", widthMm: 176, heightMm: 250 },
  { id: "B5_JIS", label: "B5 JIS", widthMm: 182, heightMm: 257 }
] as const;

export const CUSTOM_PAGE_MIN_MM = 50;
export const CUSTOM_PAGE_MAX_MM = 500;

export const millimetersToLogicalPixels = (millimeters: number): number =>
  Number((millimeters * CSS_PIXELS_PER_INCH / MILLIMETERS_PER_INCH).toFixed(3));

export const logicalPixelsToMillimeters = (pixels: number): number =>
  Number((pixels * MILLIMETERS_PER_INCH / CSS_PIXELS_PER_INCH).toFixed(3));

export const logicalPixelsToPdfPoints = (pixels: number): number =>
  pixels * PDF_POINTS_PER_INCH / CSS_PIXELS_PER_INCH;

export const pageForPreset = (
  presetId: Exclude<PagePresetId, "CUSTOM">,
  orientation: PageOrientation
): { readonly width: number; readonly height: number; readonly unit: "px" } => {
  const preset = PAGE_PRESETS.find((candidate) => candidate.id === presetId);
  if (preset === undefined) throw new Error("Unknown page preset");
  const portrait = {
    width: millimetersToLogicalPixels(preset.widthMm),
    height: millimetersToLogicalPixels(preset.heightMm),
    unit: "px" as const
  };
  return orientation === "PORTRAIT" ? portrait : { width: portrait.height, height: portrait.width, unit: "px" };
};

export const pageForCustomMillimeters = (
  widthMm: number,
  heightMm: number
): { readonly width: number; readonly height: number; readonly unit: "px" } => {
  if (!Number.isFinite(widthMm) || !Number.isFinite(heightMm)
    || widthMm < CUSTOM_PAGE_MIN_MM || heightMm < CUSTOM_PAGE_MIN_MM
    || widthMm > CUSTOM_PAGE_MAX_MM || heightMm > CUSTOM_PAGE_MAX_MM) {
    throw new Error("Custom page dimensions are outside the supported range");
  }
  return { width: millimetersToLogicalPixels(widthMm), height: millimetersToLogicalPixels(heightMm), unit: "px" };
};

export const describeLogicalPage = (page: { readonly width: number; readonly height: number }): {
  readonly presetId: PagePresetId;
  readonly orientation: PageOrientation;
  readonly widthMm: number;
  readonly heightMm: number;
} => {
  const widthMm = logicalPixelsToMillimeters(page.width);
  const heightMm = logicalPixelsToMillimeters(page.height);
  const orientation: PageOrientation = widthMm > heightMm ? "LANDSCAPE" : "PORTRAIT";
  const portraitWidth = Math.min(widthMm, heightMm);
  const portraitHeight = Math.max(widthMm, heightMm);
  const preset = PAGE_PRESETS.find((candidate) =>
    Math.abs(candidate.widthMm - portraitWidth) <= 0.25 && Math.abs(candidate.heightMm - portraitHeight) <= 0.25);
  return { presetId: preset?.id ?? "CUSTOM", orientation, widthMm, heightMm };
};

export const pageAspectRatio = (page: { readonly width: number; readonly height: number }): number => page.width / page.height;
