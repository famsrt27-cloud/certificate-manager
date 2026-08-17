import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");

describe("specification and implemented phase consistency", () => {
  it("keeps the canonical entry point, API contract and Phase 3 scope explicit", () => {
    const manifest = JSON.parse(read("MANIFEST.json")) as {
      canonical_start_file: string;
      canonical_api_contract: string;
      status: string;
      phase_1: { business_features_implemented: boolean; next_phase_authorized: boolean };
      phase_2: { phase_3_started: boolean; next_phase_authorized: boolean };
      phase_3: { phase_4_started: boolean; next_phase_authorized: boolean };
    };

    expect(manifest.canonical_start_file).toBe("CODEX-START-HERE.md");
    expect(manifest.canonical_api_contract).toBe("docs/10-api-contract.md");
    expect(manifest.status).toBe("phase-3-project-training-participant-implemented-non-production");
    expect(manifest.phase_1.business_features_implemented).toBe(false);
    expect(manifest.phase_1.next_phase_authorized).toBe(true);
    expect(manifest.phase_2.phase_3_started).toBe(true);
    expect(manifest.phase_2.next_phase_authorized).toBe(true);
    expect(manifest.phase_3.phase_4_started).toBe(false);
    expect(manifest.phase_3.next_phase_authorized).toBe(false);
  });

  it("keeps the canonical roadmap numbered from Phase 0 through Phase 8", () => {
    const roadmap = read("IMPLEMENTATION-ROADMAP.md");

    for (let phase = 0; phase <= 8; phase += 1) {
      expect(roadmap).toContain(`## Phase ${phase}`);
    }
  });

  it("documents implemented health paths consistently in API and OpenAPI sources", () => {
    const apiContract = read("docs/10-api-contract.md");
    const openApiOutline = read("docs/19-openapi-outline.md");

    for (const path of ["GET /health/live", "GET /health/ready"]) {
      expect(apiContract).toContain(path);
      expect(openApiOutline).toContain(path);
    }
    expect(apiContract).toContain("SERVICE_UNAVAILABLE");
    expect(openApiOutline).toContain("SERVICE_UNAVAILABLE");
  });

  it("keeps the initial migration snapshot byte-identical to the canonical schema", () => {
    expect(read("packages/database/schema/0001-canonical-schema.sql")).toBe(
      read("docs/09-postgresql-schema.sql")
    );
  });
});
