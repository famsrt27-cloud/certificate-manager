import { describe, expect, it } from "vitest";

import { openApiDocument } from "./openapi-document.js";

describe("Phase 3 OpenAPI document", () => {
  it("documents every implemented Phase 3 path and no later-phase operation", () => {
    expect(Object.keys(openApiDocument.paths)).toEqual(expect.arrayContaining([
      "/api/admin/projects", "/api/admin/projects/{projectId}", "/api/admin/trainings",
      "/api/admin/trainings/{trainingId}", "/api/admin/participants",
      "/api/admin/trainings/{trainingId}/participants/import", "/api/admin/participant-imports/{jobId}",
      "/api/admin/participant-imports/{jobId}/confirm", "/api/admin/jobs/{jobId}"
    ]));
    expect(Object.keys(openApiDocument.paths).some((path) => path.includes("templates") || path.includes("certificates"))).toBe(false);
  });
});
