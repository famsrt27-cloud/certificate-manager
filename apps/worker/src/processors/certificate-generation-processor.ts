import { createHash, timingSafeEqual } from "node:crypto";

import {
  CERTIFICATE_RENDER_INPUT_VERSION,
  SUPPORTED_CERTIFICATE_RENDERER_REVISIONS,
  renderCertificatePdf,
  type CertificateRenderAsset,
  type CertificateRenderInput
} from "@certificate-platform/certificate-renderer";
import {
  CERTIFICATE_GENERATION_ERROR_CODES,
  CertificateGenerationExecutionError,
  armStorageCleanup,
  beginCertificateGenerationJob,
  claimCertificateGenerationItem,
  deadLetterCertificateGeneration,
  markCertificateGenerationItemFailed,
  publishCertificateGeneration,
  type ClaimedCertificateGenerationItem,
  type DatabaseClient,
  type PublishCertificateGenerationInput
} from "@certificate-platform/database";
import { createCertificateVerificationToken, createCertificateVerificationUrl } from "@certificate-platform/domain";
import { CertificateGenerationJobPayloadSchema, type CertificateGenerationJobPayload } from "@certificate-platform/queue";
import type { PrivateObjectStorage } from "@certificate-platform/storage";
import { TemplateDefinitionSchema, collectTemplateAssetRequirements } from "@certificate-platform/template-engine";

export interface CertificateGenerationProcessorOptions {
  readonly database: DatabaseClient;
  readonly storage: PrivateObjectStorage;
  readonly verificationBaseUrl: string;
  readonly verificationKeys: ReadonlyMap<string, Readonly<Uint8Array>>;
  readonly maximumAssetBytes: number;
  readonly maximumPdfBytes: number;
  readonly claimLeaseMs?: number;
  readonly cleanupDelayMs?: number;
  readonly now?: () => Date;
  readonly render?: typeof renderCertificatePdf;
  readonly publish?: (database: DatabaseClient, input: PublishCertificateGenerationInput) => Promise<"PUBLISHED" | "ALREADY_PUBLISHED">;
}

const supportedAssetMime = (kind: "IMAGE" | "FONT", mimeType: string): mimeType is CertificateRenderAsset["mimeType"] =>
  kind === "IMAGE" ? mimeType === "image/png" || mimeType === "image/jpeg" : mimeType === "font/ttf" || mimeType === "font/otf";

const exactHash = (bytes: Uint8Array, expected: Uint8Array): boolean => {
  const actual = createHash("sha256").update(bytes).digest();
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, Buffer.from(expected));
};

const objectKeyFor = (item: ClaimedCertificateGenerationItem): string =>
  `certificates/${item.organizationId}/${item.certificateId}/revision-${item.generationRevision}.pdf`;

export class CertificateGenerationProcessor {
  readonly #database: DatabaseClient;
  readonly #storage: PrivateObjectStorage;
  readonly #verificationBaseUrl: string;
  readonly #verificationKeys: ReadonlyMap<string, Uint8Array>;
  readonly #maximumAssetBytes: number;
  readonly #maximumPdfBytes: number;
  readonly #claimLeaseMs: number;
  readonly #cleanupDelayMs: number;
  readonly #now: () => Date;
  readonly #render: typeof renderCertificatePdf;
  readonly #publish: NonNullable<CertificateGenerationProcessorOptions["publish"]>;

  constructor(options: CertificateGenerationProcessorOptions) {
    if (!Number.isSafeInteger(options.maximumAssetBytes) || options.maximumAssetBytes <= 0
      || !Number.isSafeInteger(options.maximumPdfBytes) || options.maximumPdfBytes <= 0) {
      throw new Error("Certificate generation resource limits are invalid");
    }
    this.#database = options.database;
    this.#storage = options.storage;
    this.#verificationBaseUrl = options.verificationBaseUrl;
    this.#verificationKeys = new Map([...options.verificationKeys].map(([keyId, bytes]) => [keyId, new Uint8Array(bytes)]));
    this.#maximumAssetBytes = options.maximumAssetBytes;
    this.#maximumPdfBytes = options.maximumPdfBytes;
    this.#claimLeaseMs = options.claimLeaseMs ?? 5 * 60_000;
    this.#cleanupDelayMs = options.cleanupDelayMs ?? 60 * 60_000;
    this.#now = options.now ?? (() => new Date());
    this.#render = options.render ?? renderCertificatePdf;
    this.#publish = options.publish ?? publishCertificateGeneration;
  }

  async process(untrustedPayload: CertificateGenerationJobPayload): Promise<void> {
    const payload = CertificateGenerationJobPayloadSchema.parse(untrustedPayload);
    const beginning = await beginCertificateGenerationJob(this.#database, {
      organizationId: payload.organization_id,
      jobId: payload.job_id,
      supportedRendererRevisions: SUPPORTED_CERTIFICATE_RENDERER_REVISIONS
    });
    if (beginning !== "READY") return;

    while (true) {
      const claimed = await claimCertificateGenerationItem(this.#database, {
        organizationId: payload.organization_id,
        jobId: payload.job_id,
        staleBefore: new Date(this.#now().getTime() - this.#claimLeaseMs)
      });
      if (claimed.kind === "COMPLETE") return;
      if (claimed.kind === "BUSY") throw new CertificateGenerationExecutionError(CERTIFICATE_GENERATION_ERROR_CODES.processingFailed);
      try {
        await this.#processItem(claimed.item);
      } catch (error) {
        const errorCode = error instanceof CertificateGenerationExecutionError
          ? error.code : CERTIFICATE_GENERATION_ERROR_CODES.processingFailed;
        await markCertificateGenerationItemFailed(this.#database, {
          organizationId: claimed.item.organizationId,
          jobId: claimed.item.jobId,
          itemId: claimed.item.itemId,
          errorCode
        });
        throw error;
      }
    }
  }

  async #processItem(item: ClaimedCertificateGenerationItem): Promise<void> {
    if (!SUPPORTED_CERTIFICATE_RENDERER_REVISIONS.some((revision) => revision === item.rendererRevision)
      || item.verificationKeyKid.length === 0) {
      throw new CertificateGenerationExecutionError(CERTIFICATE_GENERATION_ERROR_CODES.invalidJob);
    }
    const signingKey = this.#verificationKeys.get(item.verificationKeyKid);
    if (signingKey === undefined) throw new CertificateGenerationExecutionError(CERTIFICATE_GENERATION_ERROR_CODES.invalidJob);
    const templateDefinition = TemplateDefinitionSchema.parse(item.templateDefinition);
    const requirements = collectTemplateAssetRequirements(templateDefinition);
    if (requirements.length !== item.assets.length) {
      throw new CertificateGenerationExecutionError(CERTIFICATE_GENERATION_ERROR_CODES.invalidJob);
    }
    const assetById = new Map(item.assets.map((asset) => [asset.id, asset]));
    const renderAssets: CertificateRenderAsset[] = [];
    let totalAssetBytes = 0;
    for (const requirement of requirements) {
      const asset = assetById.get(requirement.id);
      if (asset === undefined || (asset.status !== "ACTIVE" && asset.status !== "ARCHIVED")
        || !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes <= 0
        || !supportedAssetMime(requirement.kind, asset.detectedMimeType)) {
        throw new CertificateGenerationExecutionError(CERTIFICATE_GENERATION_ERROR_CODES.invalidJob);
      }
      const remaining = this.#maximumAssetBytes - totalAssetBytes;
      if (remaining <= 0 || asset.sizeBytes > remaining) {
        throw new CertificateGenerationExecutionError(CERTIFICATE_GENERATION_ERROR_CODES.invalidJob);
      }
      const bytes = await this.#storage.get(asset.storageKey, remaining);
      if (bytes.byteLength !== asset.sizeBytes || !exactHash(bytes, asset.contentSha256)) {
        throw new CertificateGenerationExecutionError(CERTIFICATE_GENERATION_ERROR_CODES.invalidJob);
      }
      totalAssetBytes += bytes.byteLength;
      renderAssets.push({ id: asset.id, kind: requirement.kind, mimeType: asset.detectedMimeType, contentSha256: asset.contentSha256, bytes });
    }

    const token = createCertificateVerificationToken({
      keyId: item.verificationKeyKid,
      key: signingKey,
      publicIdentifier: item.publicIdentifier,
      issuedAt: item.plannedIssuedAt
    });
    const verificationUrl = createCertificateVerificationUrl(this.#verificationBaseUrl, token);
    const renderInput: CertificateRenderInput = {
      inputVersion: CERTIFICATE_RENDER_INPUT_VERSION,
      rendererRevision: item.rendererRevision as CertificateRenderInput["rendererRevision"],
      templateDefinition,
      bindings: {
        recipient: { displayName: item.recipientDisplayName },
        project: { name: item.projectName },
        training: { name: item.trainingName, code: item.trainingCode },
        certificate: { number: item.certificateNumber, issuedAt: item.plannedIssuedAt.toISOString().slice(0, 10) },
        verificationUrl
      },
      assets: renderAssets
    };
    const pdf = await this.#render(renderInput, { maxTotalAssetBytes: this.#maximumAssetBytes, maxPdfBytes: this.#maximumPdfBytes });
    const pdfBytes = new Uint8Array(pdf);
    if (pdfBytes.byteLength <= 0 || pdfBytes.byteLength > this.#maximumPdfBytes
      || Buffer.from(pdfBytes.subarray(0, 5)).toString("ascii") !== "%PDF-") {
      throw new CertificateGenerationExecutionError(CERTIFICATE_GENERATION_ERROR_CODES.processingFailed);
    }
    const contentSha256 = createHash("sha256").update(pdfBytes).digest();
    const objectKey = objectKeyFor(item);
    await armStorageCleanup(this.#database, {
      organizationId: item.organizationId,
      objectKey,
      notBefore: new Date(this.#now().getTime() + this.#cleanupDelayMs)
    });
    await this.#storage.put({ key: objectKey, body: pdfBytes, contentType: "application/pdf", contentSha256Hex: contentSha256.toString("hex") });
    await this.#publish(this.#database, {
      organizationId: item.organizationId,
      jobId: item.jobId,
      itemId: item.itemId,
      certificateId: item.certificateId,
      generationRevision: item.generationRevision,
      objectKey,
      contentSha256,
      sizeBytes: pdfBytes.byteLength,
      mimeType: "application/pdf"
    });
  }

  async handleFinalFailure(untrustedPayload: CertificateGenerationJobPayload): Promise<void> {
    const payload = CertificateGenerationJobPayloadSchema.parse(untrustedPayload);
    await deadLetterCertificateGeneration(
      this.#database,
      payload.organization_id,
      payload.job_id,
      CERTIFICATE_GENERATION_ERROR_CODES.processingFailed
    );
  }
}
