import { describe, expect, it } from "vitest";

import { openApiDocument } from "./openapi-document.js";

describe("Phase 4 OpenAPI document", () => {
  it("documents every implemented Phase 4 path and no certificate operation", () => {
    expect(Object.keys(openApiDocument.paths)).toEqual(expect.arrayContaining([
      "/api/admin/projects", "/api/admin/projects/{projectId}", "/api/admin/trainings",
      "/api/admin/trainings/{trainingId}", "/api/admin/participants",
      "/api/admin/trainings/{trainingId}/participants/import", "/api/admin/participant-imports/{jobId}",
      "/api/admin/participant-imports/{jobId}/confirm", "/api/admin/jobs/{jobId}",
      "/api/admin/templates", "/api/admin/templates/{templateId}",
      "/api/admin/templates/{templateId}/versions", "/api/admin/templates/{templateId}/versions/{versionId}",
      "/api/admin/templates/{templateId}/versions/{versionId}/preview",
      "/api/admin/templates/{templateId}/versions/{versionId}/publish", "/api/admin/templates/{templateId}/assets"
    ]));
    expect(Object.keys(openApiDocument.paths).some((path) => path.includes("certificates"))).toBe(false);
  });
});
