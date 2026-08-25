import { createHash } from "node:crypto";

import { BUNDLED_NOTO_FONTS } from "./generated-bundled-fonts.js";

export interface BundledFont {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

const fonts = new Map(BUNDLED_NOTO_FONTS.map((font) => [
  `${font.family}:${font.weight}`,
  Object.freeze({ bytes: new Uint8Array(Buffer.from(font.base64, "base64")), sha256: font.sha256 })
]));

export const getBundledFont = (family: string, weight: 400 | 700): BundledFont | undefined =>
  fonts.get(`${family}:${weight}`);

export const assertBundledFontIntegrity = (): void => {
  for (const font of fonts.values()) {
    if (createHash("sha256").update(font.bytes).digest("hex") !== font.sha256) {
      throw new Error("bundled font integrity check failed");
    }
  }
};
