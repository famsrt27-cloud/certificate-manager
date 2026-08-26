import { createHash } from "node:crypto";

import { createCertificateDownloadToken } from "@certificate-platform/domain";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { buildApi } from "../app.js";
import { PublicCertificateDownloadService } from "../modules/phase-six/public-certificate-download-service.js";

const key = Buffer.alloc(32, 51);
const publicIdentifier = "0123456789abcdef0123456789abcdef";
const issuedAt = new Date("2026-08-26T10:00:00.000Z");
const now = new Date("2026-08-26T10:00:30.000Z");
const pdf = Buffer.from("%PDF-1.7\nroute certificate\n%%EOF", "ascii");
const token = createCertificateDownloadToken({ keyId: "active", key, publicIdentifier, issuedAt,
  ttlSeconds: 60, tokenId: Buffer.alloc(16, 4).toString("base64url") });
const record = { status: "AVAILABLE" as const, pdfStorageKey: "private/certificate.pdf",
  pdfContentSha256: createHash("sha256").update(pdf).digest(), pdfSizeBytes: String(pdf.byteLength),
  pdfMimeType: "application/pdf", generationRevision: 1 };
const genericError = (requestId: unknown) => ({ error: { code: "PUBLIC_REQUEST_FAILED",
  message: "The request could not be completed." }, meta: { request_id: requestId } });

const createApp = async (allowed = true) => {
  const consume = vi.fn().mockResolvedValue({ allowed, retryAfterSeconds: allowed ? 0 : 17 });
  const findByPublicIdentifier = vi.fn().mockResolvedValue(record);
  const get = vi.fn().mockResolvedValue(pdf);
  const app = buildApi({ dependencies: { checkDatabase: async () => undefined, checkRedis: async () => undefined },
    readinessTimeoutMs: 100, logger: false, publicCertificateDownload: { rateLimiter: { consume },
      service: new PublicCertificateDownloadService({ verificationKeys: new Map([["active", key]]),
        repository: { findByPublicIdentifier }, storage: { get }, maximumPdfBytes: 1_024, now: () => now }) } });
  await app.ready();
  return { app, consume, findByPublicIdentifier, get };
};

describe("public certificate download route", () => {
  it("returns validated PDF bytes with static safe headers and no JSON envelope", async () => {
    const { app } = await createApp();
    const response = await request(app.server).post("/api/public/certificates/download").send({ download_token: token });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(pdf);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.headers["content-disposition"]).toBe('attachment; filename="certificate.pdf"');
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    await app.close();
  });

  it("accepts the token only in a strict bounded POST JSON body", async () => {
    const { app } = await createApp();
    for (const body of [{}, { download_token: "" }, { download_token: 1 },
      { download_token: token, extra: true }, { download_token: "x".repeat(2_049) }]) {
      const response = await request(app.server).post("/api/public/certificates/download").send(body);
      expect(response.status).toBe(400);
      expect(response.body).toEqual(genericError(expect.any(String)));
    }
    expect((await request(app.server).get(`/api/public/certificates/download?download_token=${token}`)).status).toBe(404);
    expect((await request(app.server).post(`/api/public/certificates/download/${token}`)).status).toBe(404);
    expect((await request(app.server).post("/api/public/certificates/download")
      .set("authorization", `Bearer ${token}`).send({})).status).toBe(400);
    expect((await request(app.server).post("/api/public/certificates/download")
      .set("cookie", `download_token=${token}`).send({})).status).toBe(400);
    await app.close();
  });

  it("rejects an oversized body during bounded parsing before rate limiting", async () => {
    const { app, consume, findByPublicIdentifier, get } = await createApp();
    const response = await request(app.server).post("/api/public/certificates/download")
      .send({ download_token: "x".repeat(5_000) });
    expect(response.status).toBe(400);
    expect(response.body).toEqual(genericError(expect.any(String)));
    expect(consume).not.toHaveBeenCalled();
    expect(findByPublicIdentifier).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    await app.close();
  });

  it("rate-limits before service work and returns a positive Retry-After with the generic body", async () => {
    const { app, consume, findByPublicIdentifier, get } = await createApp(false);
    const response = await request(app.server).post("/api/public/certificates/download").send({ download_token: token });
    expect(response.status).toBe(429);
    expect(Number(response.headers["retry-after"])).toBe(17);
    expect(response.body).toEqual(genericError(expect.any(String)));
    expect(consume).toHaveBeenCalledTimes(1);
    expect(findByPublicIdentifier).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain(token);
    await app.close();
  });

  it("maps token, state, and storage failures to the same public response", async () => {
    const { app } = await createApp();
    const segments = token.split(".");
    const signature = Buffer.from(segments[2]!, "base64url");
    signature[0] = signature[0]! ^ 1;
    for (const downloadToken of ["malformed", `${segments[0]}.${segments[1]}.${signature.toString("base64url")}`]) {
      const response = await request(app.server).post("/api/public/certificates/download")
        .send({ download_token: downloadToken });
      expect(response.status).toBe(400);
      expect(response.body).toEqual(genericError(expect.any(String)));
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
    }
    await app.close();
  });
});
