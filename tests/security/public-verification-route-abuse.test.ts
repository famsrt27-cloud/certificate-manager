import {
  createCertificateDownloadToken,
  createCertificateVerificationToken
} from "@certificate-platform/domain";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { buildApi } from "../../apps/api/src/app.js";
import { PublicVerificationService } from "../../apps/api/src/modules/phase-six/public-verification-service.js";

const key = Buffer.alloc(32, 61);
const publicIdentifier = "0123456789abcdef0123456789abcdef";
const verificationToken = createCertificateVerificationToken({
  keyId: "active-key",
  key,
  publicIdentifier,
  issuedAt: new Date("2026-08-26T00:00:00.000Z")
});
const genericError = {
  code: "PUBLIC_REQUEST_FAILED",
  message: "The request could not be completed."
};

const createApp = async () => {
  const consume = vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  const findByPublicIdentifier = vi.fn().mockResolvedValue({
    status: "AVAILABLE",
    certificateNumber: "CERT-SYNTHETIC",
    recipientName: "Synthetic Recipient",
    programName: "Synthetic Program",
    issuedAt: new Date("2026-08-26T00:00:00.000Z")
  });
  const app = buildApi({
    dependencies: { checkDatabase: async () => undefined, checkRedis: async () => undefined },
    readinessTimeoutMs: 100,
    logger: false,
    publicVerification: {
      rateLimiter: { consume },
      service: new PublicVerificationService({
        verificationKeys: new Map([["active-key", key]]),
        repository: { findByPublicIdentifier }
      })
    }
  });
  await app.ready();
  return { app, consume, findByPublicIdentifier };
};

describe("public verification route abuse", () => {
  it("rejects an oversized JSON body before rate limiting or certificate lookup", async () => {
    const { app, consume, findByPublicIdentifier } = await createApp();

    const response = await request(app.server).post("/api/public/verify")
      .send({ token: "x".repeat(5_000) });

    expect(response.status).toBe(400);
    expect(response.body.error).toEqual(genericError);
    expect(consume).not.toHaveBeenCalled();
    expect(findByPublicIdentifier).not.toHaveBeenCalled();
    await app.close();
  });

  it("ignores untrusted forwarding headers when deriving the network rate-limit bucket", async () => {
    const { app, consume } = await createApp();
    const headers = [
      ["x-forwarded-for", "198.51.100.10"],
      ["forwarded", "for=198.51.100.11"],
      ["x-real-ip", "198.51.100.12"]
    ] as const;

    for (const [name, value] of headers) {
      const response = await request(app.server).post("/api/public/verify")
        .set(name, value).send({ token: verificationToken });
      expect(response.status).toBe(200);
    }

    const addresses = consume.mock.calls.map((call) => call[0] as string);
    expect(new Set(addresses).size).toBe(1);
    expect(addresses).not.toContain("198.51.100.10");
    expect(addresses).not.toContain("198.51.100.11");
    expect(addresses).not.toContain("198.51.100.12");
    await app.close();
  });

  it("does not accept raw identifiers or a download token as verification authority", async () => {
    const { app, findByPublicIdentifier } = await createApp();
    const downloadToken = createCertificateDownloadToken({
      keyId: "active-key",
      key,
      publicIdentifier,
      issuedAt: new Date("2026-08-26T00:00:00.000Z"),
      ttlSeconds: 60,
      tokenId: Buffer.alloc(16, 7).toString("base64url")
    });

    for (const token of [
      publicIdentifier,
      "00000000-0000-4000-8000-000000000001",
      "CERT-SYNTHETIC",
      "student-reference-synthetic",
      "certificates/private/object.pdf",
      downloadToken
    ]) {
      const response = await request(app.server).post("/api/public/verify").send({ token });
      expect(response.status).toBe(400);
      expect(response.body.error).toEqual(genericError);
    }
    expect(findByPublicIdentifier).not.toHaveBeenCalled();
    await app.close();
  });
});
