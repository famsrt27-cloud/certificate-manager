import { describe, expect, it } from "vitest";

import { validateTemplateAssetUpload } from "./template-asset-upload.js";

const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

describe("validateTemplateAssetUpload", () => {
  it("detects image content and normalizes attacker-controlled filenames", async () => {
    await expect(validateTemplateAssetUpload({ filename: "../../logo.png", declaredMimeType: "image/png", bytes: onePixelPng }))
      .resolves.toMatchObject({ originalFilename: "logo.png", detectedMimeType: "image/png", widthPx: 1, heightPx: 1 });
  });

  it.each([
    ["image/svg+xml", Buffer.from("<svg><script>alert(1)</script></svg>")],
    ["image/png", Buffer.from("MZ malicious executable")],
    ["image/jpeg", onePixelPng]
  ])("rejects malicious or mismatched content", async (declaredMimeType, bytes) => {
    await expect(validateTemplateAssetUpload({ filename: "asset", declaredMimeType, bytes })).rejects.toMatchObject({ code: "UPLOAD_REJECTED" });
  });
});
