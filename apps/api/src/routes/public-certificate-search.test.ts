import { createCertificateDownloadToken, createCertificateSearchResultToken,
  createCertificateVerificationToken, verifyCertificateDownloadTokenForRedemption } from "@certificate-platform/domain";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { buildApi } from "../app.js";
import { PublicCertificateSearchService } from "../modules/phase-six/public-certificate-search-service.js";
import { PublicSearchDownloadAuthorizationService } from "../modules/phase-six/public-search-download-authorization-service.js";

const key = Buffer.alloc(32, 43);
const keys = new Map<string, Uint8Array>([["public-key", key]]);
const now = new Date("2026-08-30T11:00:00.000Z");
const publicIdentifier = "b".repeat(32);
const record = { publicIdentifier, certificateNumber: "CERT-2569-001", recipientName: "สมชาย ใจดี",
  projectName: "โครงการดิจิทัล", trainingName: "การอบรมความปลอดภัย", issuedAt: now };
const allowed = { consume: async () => ({ allowed: true as const, retryAfterSeconds: 0 }) };
const generic = (requestId: unknown) => ({ error: { code: "PUBLIC_REQUEST_FAILED",
  message: "The request could not be completed." }, meta: { request_id: requestId } });

describe("public certificate search routes", () => {
  const buildSearchApp = async (records = [record]) => {
    const search = vi.fn(async () => records);
    const app = buildApi({ dependencies: { checkDatabase: async () => undefined, checkRedis: async () => undefined },
      readinessTimeoutMs: 100, logger: false, publicCertificateSearch: { rateLimiter: allowed,
        service: new PublicCertificateSearchService({ repository: { search,
          suggestProjects: async () => [], suggestTrainings: async () => [] }, activeSigningKeyId: "public-key",
          activeSigningKey: key, ttlSeconds: 180, now: () => now }) } });
    await app.ready();
    return { app, search };
  };

  it.each([{}, { recipient_name: "สมชาย ใจดี" }, { recipient_name: "สม", project_name: "โครงการดิจิทัล" },
    { external_reference: "private", recipient_name: "สมชาย ใจดี", project_name: "โครงการดิจิทัล" },
    { certificate_number: "CERT-1", recipient_name: "สมชาย ใจดี", project_name: "โครงการดิจิทัล" }])(
    "rejects insufficient or non-canonical search input %# with one generic error", async (body) => {
      const { app, search } = await buildSearchApp();
      const response = await request(app.server).post("/api/public/certificates/search").send(body);
      expect(response.status).toBe(400);
      expect(response.body).toEqual(generic(expect.any(String)));
      expect(search).not.toHaveBeenCalled();
      await app.close();
    });

  it.each([
    { body: { recipient_name: "สมชาย ใจดี", project_name: "โครงการดิจิทัล" },
      criteria: { recipientName: "สมชาย ใจดี", projectName: "โครงการดิจิทัล" } },
    { body: { recipient_name: "สมชาย ใจดี", training_name: "การอบรมความปลอดภัย" },
      criteria: { recipientName: "สมชาย ใจดี", trainingName: "การอบรมความปลอดภัย" } },
    { body: { recipient_name: "สมชาย ใจดี", project_name: "โครงการดิจิทัล",
      training_name: "การอบรมความปลอดภัย" }, criteria: { recipientName: "สมชาย ใจดี",
      projectName: "โครงการดิจิทัล", trainingName: "การอบรมความปลอดภัย" } },
    { body: { certificate_number: "CERT-2569-001" }, criteria: { certificateNumber: "CERT-2569-001" } },
    { body: { recipient_name: "O'Reilly %_", project_name: "Project %_'" },
      criteria: { recipientName: "O'Reilly %_", projectName: "Project %_'" } }
  ])(
    "accepts deterministic bounded search input %#", async ({ body, criteria }) => {
      const { app, search } = await buildSearchApp();
      const response = await request(app.server).post("/api/public/certificates/search").send(body);
      expect(response.status).toBe(200);
      expect(search).toHaveBeenCalledWith(criteria, 11);
      expect(response.body.data.results).toHaveLength(1);
      expect(Object.keys(response.body.data.results[0]).sort()).toEqual([
        "certificate_number", "issued_at", "project_name", "recipient_name", "search_result_token", "status", "training_name"
      ]);
      expect(JSON.stringify(response.body)).not.toMatch(/public_identifier|participant|external_reference|storage|signing|uuid/i);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
      await app.close();
    });

  it("returns no partial directory page or total when more than ten records match", async () => {
    const { app } = await buildSearchApp(Array.from({ length: 11 }, () => record));
    const response = await request(app.server).post("/api/public/certificates/search")
      .send({ recipient_name: "สมชาย ใจดี", project_name: "โครงการดิจิทัล" });
    expect(response.body.data).toEqual({ results: [], too_broad: true });
    expect(JSON.stringify(response.body)).not.toMatch(/total|cursor|page/i);
    await app.close();
  });

  it("returns safe 429 plus Retry-After before validation", async () => {
    const { app } = await buildSearchApp();
    const limited = buildApi({ dependencies: { checkDatabase: async () => undefined, checkRedis: async () => undefined },
      readinessTimeoutMs: 100, logger: false, publicCertificateSearch: { service: new PublicCertificateSearchService({
        repository: { search: async () => [], suggestProjects: async () => [], suggestTrainings: async () => [] },
        activeSigningKeyId: "public-key", activeSigningKey: key,
        ttlSeconds: 180 }), rateLimiter: { consume: async () => ({ allowed: false, retryAfterSeconds: 23 }) } } });
    await limited.ready();
    const response = await request(limited.server).post("/api/public/certificates/search").send({});
    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("23");
    expect(response.body).toEqual(generic(expect.any(String)));
    await Promise.all([app.close(), limited.close()]);
  });

  it("rejects empty and too-short suggestion input without repository access", async () => {
    const { app } = await buildSearchApp();
    for (const endpoint of ["project-suggestions", "training-suggestions"]) {
      for (const body of [{}, { query: "" }, { query: "ก" }]) {
        const response = await request(app.server).post(`/api/public/certificates/${endpoint}`).send(body);
        expect(response.status).toBe(400);
        expect(response.body).toEqual(generic(expect.any(String)));
      }
    }
    await app.close();
  });

  it("returns at most ten safe training labels independently and with an optional project filter", async () => {
    const suggestProjects = vi.fn(async () => Array.from({ length: 12 }, (_, index) => `โครงการไทย ${index}`));
    const suggestTrainings = vi.fn(async () => Array.from({ length: 12 }, (_, index) => `อบรมภาษาไทย ${index}`));
    const app = buildApi({ dependencies: { checkDatabase: async () => undefined, checkRedis: async () => undefined },
      readinessTimeoutMs: 100, logger: false, publicCertificateSearch: { rateLimiter: allowed,
        service: new PublicCertificateSearchService({ repository: { search: async () => [], suggestProjects,
          suggestTrainings }, activeSigningKeyId: "public-key", activeSigningKey: key, ttlSeconds: 180 }) } });
    await app.ready();
    const projects = await request(app.server).post("/api/public/certificates/project-suggestions")
      .send({ query: "  โครงการ　ไทย " });
    expect(projects.status).toBe(200);
    expect(projects.body.data.suggestions).toHaveLength(10);
    expect(suggestProjects).toHaveBeenCalledWith("โครงการ ไทย", 10);
    const independentTrainings = await request(app.server).post("/api/public/certificates/training-suggestions")
      .send({ query: "  อบ " });
    expect(independentTrainings.status).toBe(200);
    expect(independentTrainings.body.data.suggestions).toHaveLength(10);
    expect(suggestTrainings).toHaveBeenNthCalledWith(1, undefined, "อบ", 10);
    const filteredTrainings = await request(app.server).post("/api/public/certificates/training-suggestions")
      .send({ query: "อบ", project_name: " โครงการไทย " });
    expect(filteredTrainings.status).toBe(200);
    expect(filteredTrainings.body.data.suggestions).toHaveLength(10);
    expect(suggestTrainings).toHaveBeenNthCalledWith(2, "โครงการไทย", "อบ", 10);
    expect(JSON.stringify({ projects: projects.body, independentTrainings: independentTrainings.body,
      filteredTrainings: filteredTrainings.body }))
      .not.toMatch(/uuid|organization|participant|recipient|certificate|external_reference|count|total/i);
    await app.close();
  });

  it("rate limits suggestions before validating or querying", async () => {
    const limited = buildApi({ dependencies: { checkDatabase: async () => undefined, checkRedis: async () => undefined },
      readinessTimeoutMs: 100, logger: false, publicCertificateSearch: { rateLimiter: {
        consume: async () => ({ allowed: false, retryAfterSeconds: 19 }) }, service: new PublicCertificateSearchService({
          repository: { search: async () => [], suggestProjects: async () => [], suggestTrainings: async () => [] },
          activeSigningKeyId: "public-key", activeSigningKey: key, ttlSeconds: 180 }) } });
    await limited.ready();
    const response = await request(limited.server).post("/api/public/certificates/project-suggestions").send({});
    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("19");
    expect(response.body).toEqual(generic(expect.any(String)));
    await limited.close();
  });

  it("exchanges only a valid search result capability after a fresh AVAILABLE publication check", async () => {
    const publication = { status: "AVAILABLE" as const, pdfStorageKey: "private/certificate.pdf",
      pdfContentSha256: Buffer.alloc(32, 4), pdfSizeBytes: "100", pdfMimeType: "application/pdf" };
    const findByPublicIdentifier = vi.fn(async () => publication);
    const service = new PublicSearchDownloadAuthorizationService({ verificationKeys: keys,
      activeSigningKeyId: "public-key", activeSigningKey: key, downloadTtlSeconds: 60, now: () => now,
      repository: { findByPublicIdentifier } });
    const app = buildApi({ dependencies: { checkDatabase: async () => undefined, checkRedis: async () => undefined },
      readinessTimeoutMs: 100, logger: false, publicSearchDownloadAuthorization: { rateLimiter: allowed, service } });
    const searchToken = createCertificateSearchResultToken({ keyId: "public-key", key, publicIdentifier,
      issuedAt: new Date(now.getTime() - 1_000), ttlSeconds: 180 });
    await app.ready();
    const response = await request(app.server).post("/api/public/certificates/search-download-authorize")
      .send({ search_result_token: searchToken });
    expect(response.status).toBe(200);
    expect(findByPublicIdentifier).toHaveBeenCalledWith(publicIdentifier);
    expect(verifyCertificateDownloadTokenForRedemption(response.body.data.download_token, keys, now).publicIdentifier)
      .toBe(publicIdentifier);
    expect(JSON.stringify(response.body)).not.toMatch(/public_identifier|storage|certificate_id|kid|jti/i);
    await app.close();
  });

  it("rejects expired, tampered, QR, and download tokens without repository access", async () => {
    const findByPublicIdentifier = vi.fn();
    const service = new PublicSearchDownloadAuthorizationService({ verificationKeys: keys,
      activeSigningKeyId: "public-key", activeSigningKey: key, downloadTtlSeconds: 60, now: () => now,
      repository: { findByPublicIdentifier } });
    const app = buildApi({ dependencies: { checkDatabase: async () => undefined, checkRedis: async () => undefined },
      readinessTimeoutMs: 100, logger: false, publicSearchDownloadAuthorization: { rateLimiter: allowed, service } });
    await app.ready();
    const expired = createCertificateSearchResultToken({ keyId: "public-key", key, publicIdentifier,
      issuedAt: new Date(now.getTime() - 180_000), ttlSeconds: 180 });
    const validSearch = createCertificateSearchResultToken({ keyId: "public-key", key, publicIdentifier,
      issuedAt: new Date(now.getTime() - 1_000), ttlSeconds: 180 });
    const qr = createCertificateVerificationToken({ keyId: "public-key", key, publicIdentifier, issuedAt: now });
    const download = createCertificateDownloadToken({ keyId: "public-key", key, publicIdentifier,
      issuedAt: now, ttlSeconds: 60 });
    for (const token of [expired, `${validSearch.slice(0, -1)}x`, qr, download]) {
      const response = await request(app.server).post("/api/public/certificates/search-download-authorize")
        .send({ search_result_token: token });
      expect(response.status).toBe(400);
      expect(response.body).toEqual(generic(expect.any(String)));
    }
    expect(findByPublicIdentifier).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a valid search capability when current publication is no longer AVAILABLE", async () => {
    const service = new PublicSearchDownloadAuthorizationService({ verificationKeys: keys,
      activeSigningKeyId: "public-key", activeSigningKey: key, downloadTtlSeconds: 60, now: () => now,
      repository: { findByPublicIdentifier: async () => ({ status: "REVOKED", pdfStorageKey: null,
        pdfContentSha256: null, pdfSizeBytes: null, pdfMimeType: null }) } });
    const app = buildApi({ dependencies: { checkDatabase: async () => undefined, checkRedis: async () => undefined },
      readinessTimeoutMs: 100, logger: false, publicSearchDownloadAuthorization: { rateLimiter: allowed, service } });
    await app.ready();
    const token = createCertificateSearchResultToken({ keyId: "public-key", key, publicIdentifier,
      issuedAt: new Date(now.getTime() - 1_000), ttlSeconds: 180 });
    const response = await request(app.server).post("/api/public/certificates/search-download-authorize")
      .send({ search_result_token: token });
    expect(response.status).toBe(400);
    expect(response.body).toEqual(generic(expect.any(String)));
    await app.close();
  });
});
