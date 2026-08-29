import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CERTIFICATE_RENDERER_REVISION,
  MAX_VERIFICATION_URL_BYTES,
  prepareCertificateRenderInput
} from "./render-input.js";

interface TestImageElement {
  type: "image";
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  asset_id: string;
  fit: "contain";
}

interface TestAsset {
  id: string;
  kind: "IMAGE" | "FONT";
  mimeType: "image/png" | "image/jpeg" | "font/ttf" | "font/otf";
  contentSha256: Uint8Array;
  bytes: Uint8Array;
}

interface TestRenderRequest {
  inputVersion: 1;
  rendererRevision: string;
  templateDefinition: {
    format_version: 1;
    page: { width: number; height: number; unit: "px" };
    elements: TestImageElement[];
  };
  bindings: {
    recipient: { displayName: string };
    project: { name: string };
    training: { name: string; code: string };
    certificate: { number: string; issuedAt: string };
    verificationUrl: string;
  };
  assets: TestAsset[];
}

const baseInput = (): TestRenderRequest => ({
  inputVersion: 1,
  rendererRevision: CERTIFICATE_RENDERER_REVISION,
  templateDefinition: {
    format_version: 1,
    page: { width: 500, height: 300, unit: "px" },
    elements: []
  },
  bindings: {
    recipient: { displayName: "Synthetic Recipient" },
    project: { name: "Synthetic Project" },
    training: { name: "Synthetic Training", code: "SYNTH-001" },
    certificate: { number: "CERT-SYNTH-001", issuedAt: "2026-08-24" },
    verificationUrl: "https://verify.example.invalid/verify#token=synthetic"
  },
  assets: []
});

const imageElement = (assetId: string): TestImageElement => ({
  type: "image",
  x: 10,
  y: 10,
  width: 50,
  height: 50,
  opacity: 1,
  asset_id: assetId,
  fit: "contain"
});

const imageAsset = (assetId: string, bytes: Uint8Array): TestAsset => ({
  id: assetId,
  kind: "IMAGE",
  mimeType: "image/png",
  contentSha256: new Uint8Array(createHash("sha256").update(bytes).digest()),
  bytes
});

describe("certificate renderer input boundary", () => {
  it("accepts the minimal validated immutable render context", () => {
    const prepared = prepareCertificateRenderInput(baseInput(), { maxTotalAssetBytes: 1_024 });

    expect(prepared.rendererRevision).toBe(CERTIFICATE_RENDERER_REVISION);
    expect(prepared.bindings.certificate.issuedAt).toBe("2026-08-24");
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.bindings)).toBe(true);
    expect(Object.isFrozen(prepared.templateDefinition)).toBe(true);
    expect(Object.isFrozen(prepared.assets)).toBe(true);
  });

  it("accepts only the renderer implementation revision exported by this package", () => {
    const input = baseInput();
    input.rendererRevision = "pdfkit-qrcode-v3";

    expect(() => prepareCertificateRenderInput(input, { maxTotalAssetBytes: 1_024 })).toThrow();
  });

  it("rejects wrong input versions and unknown nested render fields", () => {
    expect(() => prepareCertificateRenderInput({ ...baseInput(), inputVersion: 2 }, { maxTotalAssetBytes: 1_024 })).toThrow();
    const extraBinding = baseInput() as TestRenderRequest & { bindings: TestRenderRequest["bindings"] & { storageKey?: string } };
    extraBinding.bindings.storageKey = "private/object";
    expect(() => prepareCertificateRenderInput(extraBinding, { maxTotalAssetBytes: 1_024 })).toThrow();
  });

  it("rejects infrastructure or secret fields at the strict boundary", () => {
    expect(() => prepareCertificateRenderInput({
      ...baseInput(),
      databaseUrl: "postgresql://secret",
      signingKey: "secret",
      storageKey: "private/object"
    }, { maxTotalAssetBytes: 1_024 })).toThrow();
  });

  it("rejects invalid issue dates and token-bearing query parameters", () => {
    const invalidDate = baseInput();
    invalidDate.bindings.certificate.issuedAt = "2026-02-31";
    expect(() => prepareCertificateRenderInput(invalidDate, { maxTotalAssetBytes: 1_024 })).toThrow();

    const queryToken = baseInput();
    queryToken.bindings.verificationUrl = "https://verify.example.invalid/verify?token=forbidden";
    expect(() => prepareCertificateRenderInput(queryToken, { maxTotalAssetBytes: 1_024 })).toThrow();
  });

  it.each([
    "file:///secret", "data:text/plain,inert", "javascript:inert", "ftp://localhost/file", "https://user@verify.invalid/#token",
    "https://user:pass@verify.invalid/#token", "//verify.invalid/path", "../../secret", "http://[invalid"
  ])("rejects a verification URL outside the absolute HTTP(S) data contract", (verificationUrl) => {
    const input = baseInput();
    input.bindings.verificationUrl = verificationUrl;
    expect(() => prepareCertificateRenderInput(input, { maxTotalAssetBytes: 1_024 })).toThrow();
  });

  it("bounds verification URLs by UTF-8 bytes at the QR encoder's guaranteed byte-mode capacity", () => {
    const prefix = "https://verify.invalid/#";
    const atLimit = baseInput();
    atLimit.bindings.verificationUrl = prefix + "a".repeat(MAX_VERIFICATION_URL_BYTES - Buffer.byteLength(prefix));
    expect(() => prepareCertificateRenderInput(atLimit, { maxTotalAssetBytes: 1_024 })).not.toThrow();
    const asciiOver = baseInput();
    asciiOver.bindings.verificationUrl = `${atLimit.bindings.verificationUrl}a`;
    expect(() => prepareCertificateRenderInput(asciiOver, { maxTotalAssetBytes: 1_024 })).toThrow();
    const multibyteOver = baseInput();
    multibyteOver.bindings.verificationUrl = prefix + "ก".repeat(800);
    expect(multibyteOver.bindings.verificationUrl.length).toBeLessThan(MAX_VERIFICATION_URL_BYTES);
    expect(() => prepareCertificateRenderInput(multibyteOver, { maxTotalAssetBytes: 1_024 })).toThrow();
  });

  it("requires exactly the template-referenced asset set and verifies SHA-256 identity", () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const assetId = randomUUID();
    const input = baseInput();
    input.templateDefinition.elements = [imageElement(assetId)];
    input.assets = [imageAsset(assetId, bytes)];

    const prepared = prepareCertificateRenderInput(input, { maxTotalAssetBytes: 1_024 });
    expect(prepared.assets).toHaveLength(1);
    expect(Object.isFrozen(prepared.assets[0])).toBe(true);

    const tampered = baseInput();
    tampered.templateDefinition.elements = [imageElement(assetId)];
    tampered.assets = [{
      ...imageAsset(assetId, bytes),
      contentSha256: new Uint8Array(32)
    }];
    expect(() => prepareCertificateRenderInput(tampered, { maxTotalAssetBytes: 1_024 })).toThrow();
  });

  it("rejects asset purpose/MIME mismatch, duplicates, missing, extra and over-budget assets", () => {
    const bytes = Uint8Array.from([9, 8, 7, 6]);
    const assetId = randomUUID();

    const wrongMime = baseInput();
    wrongMime.templateDefinition.elements = [imageElement(assetId)];
    wrongMime.assets = [{
      ...imageAsset(assetId, bytes),
      mimeType: "font/ttf"
    }];
    expect(() => prepareCertificateRenderInput(wrongMime, { maxTotalAssetBytes: 1_024 })).toThrow();

    const wrongKind = baseInput();
    wrongKind.templateDefinition.elements = [imageElement(assetId)];
    wrongKind.assets = [{
      ...imageAsset(assetId, bytes),
      kind: "FONT",
      mimeType: "font/ttf"
    }];
    expect(() => prepareCertificateRenderInput(wrongKind, { maxTotalAssetBytes: 1_024 })).toThrow();

    const missing = baseInput();
    missing.templateDefinition.elements = [imageElement(assetId)];
    expect(() => prepareCertificateRenderInput(missing, { maxTotalAssetBytes: 1_024 })).toThrow();

    const validAsset = imageAsset(assetId, bytes);
    const duplicate = baseInput();
    duplicate.templateDefinition.elements = [imageElement(assetId)];
    duplicate.assets = [validAsset, { ...validAsset }];
    expect(() => prepareCertificateRenderInput(duplicate, { maxTotalAssetBytes: 1_024 })).toThrow();

    const extra = baseInput();
    extra.assets = [validAsset];
    expect(() => prepareCertificateRenderInput(extra, { maxTotalAssetBytes: 1_024 })).toThrow();

    const overBudget = baseInput();
    overBudget.templateDefinition.elements = [imageElement(assetId)];
    overBudget.assets = [validAsset];
    expect(() => prepareCertificateRenderInput(overBudget, { maxTotalAssetBytes: 2 })).toThrow();

    const exactBudget = baseInput();
    exactBudget.templateDefinition.elements = [imageElement(assetId)];
    exactBudget.assets = [validAsset];
    expect(() => prepareCertificateRenderInput(exactBudget, { maxTotalAssetBytes: bytes.byteLength })).not.toThrow();
    expect(() => prepareCertificateRenderInput(exactBudget, { maxTotalAssetBytes: bytes.byteLength - 1 })).toThrow();
  });

  it("rejects empty assets, malformed hashes, and unknown asset fields", () => {
    const assetId = randomUUID();
    const input = baseInput();
    input.templateDefinition.elements = [imageElement(assetId)];
    input.assets = [{ ...imageAsset(assetId, Uint8Array.from([1])), bytes: new Uint8Array() }];
    expect(() => prepareCertificateRenderInput(input, { maxTotalAssetBytes: 1_024 })).toThrow();

    const malformedHash = baseInput();
    malformedHash.templateDefinition.elements = [imageElement(assetId)];
    malformedHash.assets = [{ ...imageAsset(assetId, Uint8Array.from([1])), contentSha256: new Uint8Array(31) }];
    expect(() => prepareCertificateRenderInput(malformedHash, { maxTotalAssetBytes: 1_024 })).toThrow();

    const extraField = baseInput();
    extraField.templateDefinition.elements = [imageElement(assetId)];
    extraField.assets = [{ ...imageAsset(assetId, Uint8Array.from([1])), url: "http://169.254.169.254" } as TestAsset];
    expect(() => prepareCertificateRenderInput(extraField, { maxTotalAssetBytes: 1_024 })).toThrow();
  });

  it("copies asset identity and bytes so caller mutation cannot alter prepared input", () => {
    const bytes = Uint8Array.from([4, 3, 2, 1]);
    const assetId = randomUUID();
    const asset = imageAsset(assetId, bytes);
    const input = baseInput();
    input.templateDefinition.elements = [imageElement(assetId)];
    input.assets = [asset];

    const prepared = prepareCertificateRenderInput(input, { maxTotalAssetBytes: 1_024 });
    const originalHashByte = prepared.assets[0]?.contentSha256[0];

    bytes[0] = 99;
    asset.contentSha256[0] = 99;

    expect(prepared.assets[0]?.bytes[0]).toBe(4);
    expect(prepared.assets[0]?.contentSha256[0]).toBe(originalHashByte);
  });

  it("rejects an invalid aggregate byte budget", () => {
    expect(() => prepareCertificateRenderInput(baseInput(), { maxTotalAssetBytes: 0 })).toThrow();
    expect(() => prepareCertificateRenderInput(baseInput(), { maxTotalAssetBytes: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  });
});

