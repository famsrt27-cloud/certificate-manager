import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import { ApplicationError } from "../../errors/application-error.js";

const CursorPayloadSchema = z.object({
  version: z.literal(1),
  organization_id: z.uuid(),
  resource: z.enum(["projects", "trainings", "participants", "participant_import_rows", "templates",
    "template_versions", "template_assets"]),
  created_at: z.iso.datetime({ offset: true }),
  id: z.uuid()
}).strict();
const CURSOR_MAX_BYTES = 2_048;
const CANONICAL_BASE64URL = /^[A-Za-z0-9_-]+$/;

export type CursorResource = z.infer<typeof CursorPayloadSchema>["resource"];

export class CursorCodec {
  readonly #key: Buffer;

  constructor(secret: string) {
    this.#key = createHash("sha256").update("certificate-platform:admin-cursor:v1\0").update(secret).digest();
  }

  encode(input: { organizationId: string; resource: CursorResource; createdAt: Date; id: string }): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const plaintext = Buffer.from(JSON.stringify({
      version: 1,
      organization_id: input.organizationId,
      resource: input.resource,
      created_at: input.createdAt.toISOString(),
      id: input.id
    }), "utf8");
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
  }

  decode(cursor: string, organizationId: string, resource: CursorResource): { createdAt: Date; id: string } {
    try {
      if (Buffer.byteLength(cursor, "utf8") > CURSOR_MAX_BYTES || !CANONICAL_BASE64URL.test(cursor)) {
        throw new Error("cursor encoding invalid");
      }
      const bytes = Buffer.from(cursor, "base64url");
      if (bytes.length < 29) throw new Error("cursor too short");
      const decipher = createDecipheriv("aes-256-gcm", this.#key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const plaintext = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
      const parsed = CursorPayloadSchema.parse(JSON.parse(plaintext));
      if (parsed.organization_id !== organizationId || parsed.resource !== resource) throw new Error("cursor scope mismatch");
      return { createdAt: new Date(parsed.created_at), id: parsed.id };
    } catch {
      throw new ApplicationError("VALIDATION_FAILED", "The request could not be processed.", 400);
    }
  }
}
