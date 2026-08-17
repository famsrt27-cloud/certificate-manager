import { describe, expect, it } from "vitest";
import {
  ErrorResponseSchema,
  createErrorResponse,
  createLivenessResponse,
  createReadinessResponse
} from "./foundation.js";

const requestId = "7f7dc332-d45f-4cee-bf5c-16e7266a8633";

describe("foundation wire contracts", () => {
  it("builds canonical liveness and readiness envelopes", () => {
    expect(createLivenessResponse("api", requestId)).toEqual({
      data: { status: "ok", service: "api" },
      meta: { request_id: requestId }
    });
    expect(createReadinessResponse("worker", requestId).data.status).toBe("ready");
  });

  it("rejects non-canonical error codes", () => {
    expect(() => createErrorResponse("invalid-code", "Safe message", requestId)).toThrow();
    expect(
      ErrorResponseSchema.parse(createErrorResponse("SERVICE_NOT_READY", "Service is not ready.", requestId))
    ).toBeDefined();
  });
});
