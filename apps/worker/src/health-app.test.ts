import { ErrorResponseSchema, LivenessResponseSchema } from "@certificate-platform/contracts";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { buildWorkerHealthApp } from "./health-app.js";

describe("worker health boundary", () => {
  it("reports liveness without exposing worker internals", async () => {
    const app = buildWorkerHealthApp({
      dependencies: {
        checkDatabase: vi.fn().mockResolvedValue(undefined),
        checkRedis: vi.fn().mockResolvedValue(undefined)
      },
      readinessTimeoutMs: 100,
      logger: false
    });
    await app.ready();

    const response = await request(app.server).get("/health/live");

    expect(response.status).toBe(200);
    expect(LivenessResponseSchema.parse(response.body).data.service).toBe("worker");
    await app.close();
  });

  it("returns a safe readiness failure", async () => {
    const app = buildWorkerHealthApp({
      dependencies: {
        checkDatabase: vi.fn().mockResolvedValue(undefined),
        checkRedis: vi.fn().mockRejectedValue(new Error("private redis detail"))
      },
      readinessTimeoutMs: 100,
      logger: false
    });
    await app.ready();

    const response = await request(app.server).get("/health/ready");
    const body = ErrorResponseSchema.parse(response.body);

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(JSON.stringify(body)).not.toContain("private redis detail");
    await app.close();
  });
});
