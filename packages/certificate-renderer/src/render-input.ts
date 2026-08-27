import { createHash, timingSafeEqual } from "node:crypto";

import {
  TemplateDefinitionSchema,
  collectTemplateAssetRequirements,
  type TemplateBindingContext,
  type TemplateDefinition
} from "@certificate-platform/template-engine";
import { z } from "zod";

export const CERTIFICATE_RENDER_INPUT_VERSION = 1 as const;
export const CERTIFICATE_RENDERER_REVISION = "pdfkit-qrcode-v1" as const;
export const MAX_VERIFICATION_URL_BYTES = 2_331;

const mimeSchema = z.enum(["image/png", "image/jpeg", "font/ttf", "font/otf"]);
const assetKindSchema = z.enum(["IMAGE", "FONT"]);
const bytesSchema = z.instanceof(Uint8Array).refine((value) => value.byteLength > 0, {
  message: "asset bytes must not be empty"
});
const sha256Schema = z.instanceof(Uint8Array).refine((value) => value.byteLength === 32, {
  message: "asset SHA-256 must be 32 bytes"
});
const issuedAtSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, { message: "issuedAt must be a real UTC calendar date" });

const verificationUrlSchema = z.string().max(MAX_VERIFICATION_URL_BYTES).refine((value) => {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:")
      && parsed.username.length === 0
      && parsed.password.length === 0
      && parsed.search.length === 0
      && Buffer.byteLength(value, "utf8") <= MAX_VERIFICATION_URL_BYTES;
  } catch {
    return false;
  }
}, { message: "verificationUrl must be an absolute HTTP(S) URL without credentials or query parameters" });

const renderAssetSchema = z.object({
  id: z.uuid(),
  kind: assetKindSchema,
  mimeType: mimeSchema,
  contentSha256: sha256Schema,
  bytes: bytesSchema
}).strict();

const bindingContextSchema = z.object({
  recipient: z.object({
    displayName: z.string().min(1).max(500)
  }).strict(),
  project: z.object({
    name: z.string().min(1).max(500)
  }).strict(),
  training: z.object({
    name: z.string().min(1).max(500),
    code: z.string().min(1).max(200)
  }).strict(),
  certificate: z.object({
    number: z.string().min(1).max(500),
    issuedAt: issuedAtSchema
  }).strict(),
  verificationUrl: verificationUrlSchema
}).strict();

const certificateRenderInputSchema = z.object({
  inputVersion: z.literal(CERTIFICATE_RENDER_INPUT_VERSION),
  rendererRevision: z.literal(CERTIFICATE_RENDERER_REVISION),
  templateDefinition: TemplateDefinitionSchema,
  bindings: bindingContextSchema,
  assets: z.array(renderAssetSchema).max(200)
}).strict();

export interface CertificateRenderAsset {
  readonly id: string;
  readonly kind: "IMAGE" | "FONT";
  readonly mimeType: "image/png" | "image/jpeg" | "font/ttf" | "font/otf";
  readonly contentSha256: Readonly<Uint8Array>;
  readonly bytes: Readonly<Uint8Array>;
}

export interface CertificateRenderInput {
  readonly inputVersion: typeof CERTIFICATE_RENDER_INPUT_VERSION;
  readonly rendererRevision: typeof CERTIFICATE_RENDERER_REVISION;
  readonly templateDefinition: TemplateDefinition;
  readonly bindings: TemplateBindingContext;
  readonly assets: readonly CertificateRenderAsset[];
}

export interface CertificateRenderBoundaryOptions {
  readonly maxTotalAssetBytes: number;
}

const deepFreezePlain = <T>(value: T): T => {
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezePlain(child);
    Object.freeze(value);
  }
  return value;
};

const mimeMatchesKind = (kind: "IMAGE" | "FONT", mimeType: CertificateRenderAsset["mimeType"]): boolean =>
  kind === "IMAGE"
    ? mimeType === "image/png" || mimeType === "image/jpeg"
    : mimeType === "font/ttf" || mimeType === "font/otf";

const verifyAssetHash = (asset: {
  readonly contentSha256: Uint8Array;
  readonly bytes: Uint8Array;
}): boolean => {
  const calculated = createHash("sha256").update(asset.bytes).digest();
  return timingSafeEqual(calculated, Buffer.from(asset.contentSha256));
};

export const prepareCertificateRenderInput = (
  input: unknown,
  options: CertificateRenderBoundaryOptions
): CertificateRenderInput => {
  if (!Number.isSafeInteger(options.maxTotalAssetBytes) || options.maxTotalAssetBytes <= 0) {
    throw new Error("maxTotalAssetBytes must be a positive safe integer");
  }

  const parsed = certificateRenderInputSchema.parse(input);
  const requirements = collectTemplateAssetRequirements(parsed.templateDefinition);
  const requirementsById = new Map(requirements.map((requirement) => [requirement.id, requirement.kind]));
  const seen = new Set<string>();
  let totalAssetBytes = 0;

  for (const asset of parsed.assets) {
    if (seen.has(asset.id)) throw new Error("render assets must be unique");
    seen.add(asset.id);

    const requiredKind = requirementsById.get(asset.id);
    if (requiredKind === undefined) throw new Error("render input contains an unreferenced asset");
    if (requiredKind !== asset.kind) throw new Error("render asset kind does not match template requirement");
    if (!mimeMatchesKind(asset.kind, asset.mimeType)) throw new Error("render asset MIME does not match its purpose");
    if (!verifyAssetHash(asset)) throw new Error("render asset content does not match its SHA-256 identity");

    totalAssetBytes += asset.bytes.byteLength;
    if (totalAssetBytes > options.maxTotalAssetBytes) {
      throw new Error("render asset byte budget exceeded");
    }
  }

  if (seen.size !== requirements.length) {
    throw new Error("render input is missing a required template asset");
  }

  const normalizedAssets = parsed.assets.map((asset): CertificateRenderAsset => Object.freeze({
    id: asset.id,
    kind: asset.kind,
    mimeType: asset.mimeType,
    contentSha256: new Uint8Array(asset.contentSha256),
    bytes: new Uint8Array(asset.bytes)
  }));

  const prepared: CertificateRenderInput = {
    inputVersion: parsed.inputVersion,
    rendererRevision: parsed.rendererRevision,
    templateDefinition: deepFreezePlain(parsed.templateDefinition),
    bindings: deepFreezePlain(parsed.bindings),
    assets: Object.freeze(normalizedAssets)
  };

  return Object.freeze(prepared);
};

