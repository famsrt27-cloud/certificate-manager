import { describe, expect, it } from "vitest";

import {
  describeLogicalPage,
  logicalPixelsToPdfPoints,
  pageForCustomMillimeters,
  pageForPreset
} from "./page-size.js";

describe("certificate page size model", () => {
  it.each([
    ["A4", "PORTRAIT", 210, 297], ["A4", "LANDSCAPE", 297, 210],
    ["A5", "PORTRAIT", 148, 210], ["A5", "LANDSCAPE", 210, 148],
    ["B5_ISO", "PORTRAIT", 176, 250], ["B5_ISO", "LANDSCAPE", 250, 176],
    ["B5_JIS", "PORTRAIT", 182, 257], ["B5_JIS", "LANDSCAPE", 257, 182]
  ] as const)("maps %s %s to physical dimensions", (preset, orientation, widthMm, heightMm) => {
    const page = pageForPreset(preset, orientation);
    const described = describeLogicalPage(page);
    expect(described.widthMm).toBeCloseTo(widthMm, 2);
    expect(described.heightMm).toBeCloseTo(heightMm, 2);
    expect(logicalPixelsToPdfPoints(page.width)).toBeCloseTo(widthMm * 72 / 25.4, 2);
    expect(logicalPixelsToPdfPoints(page.height)).toBeCloseTo(heightMm * 72 / 25.4, 2);
  });

  it("keeps custom millimeters separate from raster resolution", () => {
    const page = pageForCustomMillimeters(297, 210);
    expect(page.width).not.toBe(3508);
    expect(describeLogicalPage(page)).toMatchObject({ presetId: "A4", orientation: "LANDSCAPE" });
  });

  it("recognizes the historical 1123 by 794 definition as compatible A4 landscape", () => {
    expect(describeLogicalPage({ width: 1123, height: 794 })).toMatchObject({ presetId: "A4", orientation: "LANDSCAPE" });
  });
});
