import { describe, expect, it } from "vitest";

import { openApiDocument } from "./openapi-document.js";

describe("OpenAPI document", () => {
  it("documents implemented admin and Phase 6 public paths", () => {
    expect(Object.keys(openApiDocument.paths)).toEqual(expect.arrayContaining([
      "/api/admin/projects", "/api/admin/projects/{projectId}", "/api/admin/trainings",
      "/api/admin/trainings/{trainingId}", "/api/admin/participants",
      "/api/admin/trainings/{trainingId}/participants/import", "/api/admin/participant-imports/{jobId}",
      "/api/admin/participant-imports/{jobId}/confirm", "/api/admin/jobs/{jobId}",
      "/api/admin/templates", "/api/admin/templates/{templateId}",
      "/api/admin/templates/{templateId}/versions", "/api/admin/templates/{templateId}/versions/{versionId}",
      "/api/admin/templates/{templateId}/versions/{versionId}/preview",
      "/api/admin/templates/{templateId}/versions/{versionId}/publish", "/api/admin/templates/{templateId}/assets",
      "/api/public/verify", "/api/public/certificates/download-authorize",
      "/api/public/certificates/download"
    ]));
  });

  it("describes binary certificate redemption without storage or identifier disclosure", () => {
    const operation = openApiDocument.paths["/api/public/certificates/download"].post;
    expect(operation.security).toEqual([]);
    expect(Object.keys(operation.requestBody.content["application/json"].schema.properties ?? {}))
      .toEqual(["download_token"]);
    expect(operation.responses[200].content["application/pdf"].schema).toEqual({ type: "string", format: "binary" });
    expect(JSON.stringify(operation)).not.toMatch(/storage_key|bucket|object_url|public_identifier|certificate_uuid|sha256|kid|jti/i);
  });
});
