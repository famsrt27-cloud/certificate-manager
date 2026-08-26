import { describe, expect, it } from "vitest";

import { createStructuredLoggerOptions } from "./logging.js";

describe("structured logging privacy", () => {
  it("redacts public verification tokens from request bodies", () => {
    const options = createStructuredLoggerOptions("info");

    expect(options.redact.paths).toContain("req.body.token");
    expect(options.redact.paths).toContain("token");
    expect(options.redact.paths).toContain("req.body.download_token");
    expect(options.redact.paths).toContain("download_token");
    expect(options.redact.paths).toContain("downloadToken");
    expect(options.redact.paths).toContain("verificationToken");
    expect(options.redact.paths).toContain("jti");
    expect(options.redact.paths).toContain("rawJti");
    expect(options.redact.paths).toContain("signingKey");
    expect(options.redact.paths).toContain("hmacKey");
    expect(options.redact.paths).toContain("sessionId");
    expect(options.redact.paths).toContain("csrfToken");
    expect(options.redact.paths).toContain("storageKey");
    expect(options.redact.censor).toBe("[REDACTED]");
  });
});
