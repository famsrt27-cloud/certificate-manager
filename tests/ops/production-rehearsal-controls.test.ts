import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const gate = join(process.cwd(), "ops", "rehearsal", "completion-gate.mjs");
const required = [
  "compose_configuration", "production_images", "migration_first_run", "migration_idempotency",
  "migration_advisory_lock", "https_edge", "private_operator_boundary", "security_configuration",
  "restored_data_runtime", "postgres_failure", "redis_failure", "storage_failure",
  "worker_queue_recovery", "rollback_forward_recovery", "key_lifecycle"
];

function runGate(status: object) {
  const directory = mkdtempSync(join(tmpdir(), "certificate-platform-rehearsal-gate-"));
  const file = join(directory, "status.json");
  writeFileSync(file, JSON.stringify(status));
  const result = spawnSync(process.execPath, [gate, file], { encoding: "utf8" });
  rmSync(directory, { recursive: true, force: true });
  return result;
}

describe("Phase 8.5 production rehearsal controls", () => {
  it("uses production targets and keeps every synthetic dependency private", () => {
    const compose = readFileSync(join(process.cwd(), "compose.rehearsal.yaml"), "utf8");
    const runner = readFileSync(join(process.cwd(), "ops", "rehearsal", "run-rehearsal.ps1"), "utf8");
    expect(runner).toContain("compose.production.yaml");
    expect(compose).toContain("NODE_EXTRA_CA_CERTS");
    expect(compose).toContain("secrets: !reset []");
    expect(compose).toContain('user: "101:0"');
    expect(compose).toContain("target: /run/secrets/tls_private_key");
    expect(runner).toContain("chmod 0640 /work/edge.key");
    expect(compose).toContain("postgres:16.12-alpine");
    expect(runner).toContain("tls-port 6379");
    expect(compose).toContain("MINIO_ROOT_PASSWORD");
    expect(compose).not.toMatch(/postgres:[\s\S]{0,500}\n\s+ports:/);
    expect(compose).not.toMatch(/redis:[\s\S]{0,500}\n\s+ports:/);
    expect(compose).not.toMatch(/storage:[\s\S]{0,500}\n\s+ports:/);
  });

  it("makes migration execution explicit and refuses to manufacture completion evidence", () => {
    const source = readFileSync(join(process.cwd(), "ops", "rehearsal", "run-rehearsal.ps1"), "utf8");
    expect(source).toContain("Invoke-Compose run --rm migrate");
    expect(source).toContain("Invoke-Compose wait storage-bootstrap");
    expect(source).toContain("OBJECT_STORAGE_FORCE_PATH_STYLE=true");
    expect(source).toContain("pg_advisory_lock(7241865325823964)");
    expect(source).toContain("MIGRATION_ADVISORY_LOCK_NOT_ENFORCED");
    expect(source).toContain("--ssl-no-revoke");
    expect(source).toContain('"BLOCKED" "OPERATOR_EXERCISE_NOT_RECORDED"');
    expect(source).not.toContain('foreach ($name in @("https_edge", "private_operator_boundary"');
    expect(source).toContain("down --volumes --remove-orphans");
  });

  it("returns non-zero for incomplete evidence and PASS only for every mandatory PASS", () => {
    const blocked = runGate({ schema_version: 1, checks: [{ name: "compose_configuration", status: "PASS", reason_code: "OK" }] });
    expect(blocked.status).toBe(1);
    const complete = runGate({ schema_version: 1, checks: required.map((name) => ({ name, status: "PASS", reason_code: "OBSERVED" })) });
    expect(complete.status).toBe(0);
    expect(complete.stdout).toContain('"PASS"');

    const contradictory = runGate({
      schema_version: 1,
      checks: [
        ...required.map((name) => ({ name, status: "PASS", reason_code: "OBSERVED" })),
        { name: "https_edge", status: "FAIL", reason_code: "CONTRADICTORY_EVIDENCE" }
      ]
    });
    expect(contradictory.status).toBe(1);
    expect(contradictory.stdout).toContain('"https_edge"');
  });

  it("keeps real alert routing and ownership outside repository completion", () => {
    const status = {
      schema_version: 1,
      checks: [
        ...required.map((name) => ({ name, status: "PASS", reason_code: "OBSERVED" })),
        { name: "alert_ownership", status: "BLOCKED", reason_code: "EXTERNAL_ALERT_ROUTE_AND_OWNER_REQUIRED" }
      ]
    };
    const result = runGate(status);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"result":"PASS"');
  });
});
