import { randomUUID } from "node:crypto";

import {
  ErrorResponseSchema,
  LivenessResponseSchema,
  ReadinessResponseSchema
} from "@certificate-platform/contracts";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { buildApi } from "./app.js";

const healthyDependencies = () => ({
  checkDatabase: vi.fn().mockResolvedValue(undefined),
  checkRedis: vi.fn().mockResolvedValue(undefined)
});

describe("API foundation", () => {
  it("returns liveness with a server-issued request ID", async () => {
    const app = buildApi({ dependencies: healthyDependencies(), readinessTimeoutMs: 100, logger: false });
    await app.ready();
    const clientRequestId = randomUUID();

    const response = await request(app.server).get("/health/live").set("x-request-id", clientRequestId);
    const body = LivenessResponseSchema.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ status: "ok", service: "api" });
    expect(body.meta.request_id).not.toBe(clientRequestId);
    expect(response.headers["x-request-id"]).toBe(body.meta.request_id);
    await app.close();
  });

  it("checks PostgreSQL and Redis readiness", async () => {
    const dependencies = healthyDependencies();
    const app = buildApi({ dependencies, readinessTimeoutMs: 100, logger: false });
    await app.ready();

    const response = await request(app.server).get("/health/ready");

    expect(response.status).toBe(200);
    expect(ReadinessResponseSchema.parse(response.body).data.status).toBe("ready");
    expect(dependencies.checkDatabase).toHaveBeenCalledOnce();
    expect(dependencies.checkRedis).toHaveBeenCalledOnce();
    await app.close();
  });

  it("returns a safe error when a readiness dependency fails", async () => {
    const app = buildApi({
      dependencies: {
        checkDatabase: vi.fn().mockRejectedValue(new Error("secret database detail")),
        checkRedis: vi.fn().mockResolvedValue(undefined)
      },
      readinessTimeoutMs: 100,
      logger: false
    });
    await app.ready();

    const response = await request(app.server).get("/health/ready");
    const body = ErrorResponseSchema.parse(response.body);

    expect(response.status).toBe(503);
    expect(body.error).toEqual({
      code: "SERVICE_UNAVAILABLE",
      message: "The service is not ready."
    });
    expect(JSON.stringify(body)).not.toContain("secret database detail");
    await app.close();
  });

  it("uses the standard envelope for unknown routes", async () => {
    const app = buildApi({ dependencies: healthyDependencies(), readinessTimeoutMs: 100, logger: false });
    await app.ready();

    const response = await request(app.server).get("/missing");

    expect(response.status).toBe(404);
    expect(ErrorResponseSchema.parse(response.body).error.code).toBe("NOT_FOUND");
    await app.close();
  });

  it("exposes only aggregate internal metrics without request values", async () => {
    const app = buildApi({ dependencies: healthyDependencies(), readinessTimeoutMs: 100, logger: false });
    app.post("/api/public/verify", async () => ({ ok: true }));
    await app.ready();

    await request(app.server).post("/api/public/verify").send({ token: "must-not-appear-in-metrics" });
    const response = await request(app.server).get("/metrics");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.text).toContain("certificate_platform_http_requests_total");
    expect(response.text).toContain("certificate_platform_public_verification_total");
    expect(response.text).not.toContain("must-not-appear-in-metrics");
    await app.close();
  });
});
