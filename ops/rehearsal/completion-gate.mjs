import { readFile } from "node:fs/promises";

const requiredChecks = [
  "compose_configuration", "production_images", "migration_first_run", "migration_idempotency",
  "migration_advisory_lock", "https_edge", "private_operator_boundary", "security_configuration",
  "restored_data_runtime", "postgres_failure", "redis_failure", "storage_failure",
  "worker_queue_recovery", "rollback_forward_recovery", "key_lifecycle"
];

const statusPath = process.argv[2];
if (!statusPath) throw new Error("Usage: node ops/rehearsal/completion-gate.mjs <sanitized-status.json>");

const status = JSON.parse(await readFile(statusPath, "utf8"));
if (status.schema_version !== 1 || !Array.isArray(status.checks)) {
  throw new Error("Invalid rehearsal status artifact.");
}

const byName = new Map(status.checks.map((check) => [check.name, check]));
const invalid = [];
for (const name of requiredChecks) {
  const matching = status.checks.filter((check) => check?.name === name);
  const check = matching[0];
  if (matching.length !== 1 || !check || !["PASS", "FAIL", "BLOCKED"].includes(check.status) || typeof check.reason_code !== "string") {
    invalid.push(name);
  }
}
if (invalid.length > 0) {
  console.log(JSON.stringify({ result: "FAIL", reason_code: "MISSING_OR_INVALID_EVIDENCE", checks: invalid }));
  process.exitCode = 1;
} else {
  const blockers = requiredChecks.filter((name) => byName.get(name).status === "BLOCKED");
  const failures = requiredChecks.filter((name) => byName.get(name).status === "FAIL");
  const result = failures.length > 0 ? "FAIL" : blockers.length > 0 ? "BLOCKED" : "PASS";
  console.log(JSON.stringify({ result, failures, blockers }));
  process.exitCode = result === "PASS" ? 0 : result === "FAIL" ? 1 : 2;
}
