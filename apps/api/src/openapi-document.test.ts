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
      "/api/admin/certificates", "/api/admin/trainings/{trainingId}/certificates/generate",
      "/api/admin/certificates/{certificateId}/pdf", "/api/admin/certificates/{certificateId}/revoke",
      "/api/public/verify", "/api/public/certificates/download-authorize",
      "/api/admin/organizations/current", "/api/public/certificates/project-suggestions",
      "/api/public/certificates/training-suggestions", "/api/public/certificates/search",
      "/api/public/certificates/search-download-authorize",
      "/api/public/certificates/download"
    ]));
  });

  it("documents tenant-authenticated certificate PDF access separately from metadata read", () => {
    const operation = openApiDocument.paths["/api/admin/certificates/{certificateId}/pdf"].get;
    expect(operation["x-required-permission"]).toBe("certificate:download");
    expect(operation.responses[200].content["application/pdf"].schema).toEqual({ type: "string", format: "binary" });
    expect(JSON.stringify(operation)).not.toMatch(/storage_key|bucket|object_url|public_identifier|verification_token|sha256/i);
  });

  it("describes binary certificate redemption without storage or identifier disclosure", () => {
    const operation = openApiDocument.paths["/api/public/certificates/download"].post;
    expect(operation.security).toEqual([]);
    expect(Object.keys(operation.requestBody.content["application/json"].schema.properties ?? {}))
      .toEqual(["download_token"]);
    expect(operation.responses[200].content["application/pdf"].schema).toEqual({ type: "string", format: "binary" });
    expect(JSON.stringify(operation)).not.toMatch(/storage_key|bucket|object_url|public_identifier|certificate_uuid|sha256|kid|jti/i);
  });

  it("documents bounded search and its distinct capability exchange without internal identifiers", () => {
    const search = openApiDocument.paths["/api/public/certificates/search"].post;
    const exchange = openApiDocument.paths["/api/public/certificates/search-download-authorize"].post;
    expect(search.security).toEqual([]);
    expect(Object.keys(search.requestBody.content["application/json"].schema.properties ?? {}).sort())
      .toEqual(["certificate_number", "project_name", "recipient_name", "training_name"]);
    expect(Object.keys(exchange.requestBody.content["application/json"].schema.properties ?? {}))
      .toEqual(["search_result_token"]);
    expect(JSON.stringify({ search, exchange })).not.toMatch(/public_identifier|participant_id|external_reference|storage_key|kid|jti/i);
  });

  it("documents safe suggestion labels and the canonical organization update permission", () => {
    const project = openApiDocument.paths["/api/public/certificates/project-suggestions"].post;
    const training = openApiDocument.paths["/api/public/certificates/training-suggestions"].post;
    const setting = openApiDocument.paths["/api/admin/organizations/current"].patch;
    expect(project.security).toEqual([]);
    expect(Object.keys(project.requestBody.content["application/json"].schema.properties ?? {})).toEqual(["query"]);
    expect(Object.keys(training.requestBody.content["application/json"].schema.properties ?? {}).sort())
      .toEqual(["project_name", "query"]);
    expect(training.requestBody.content["application/json"].schema.required).toEqual(["query"]);
    expect(setting["x-required-permission"]).toBe("organization:update");
    expect(JSON.stringify({ project: project.responses[200]!.content["application/json"]!.schema.properties!.data,
      training: training.responses[200]!.content["application/json"]!.schema.properties!.data }))
      .not.toMatch(/uuid|participant|recipient|external_reference|count|total/i);
  });
});
