import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { validateDurableObjectManifest } from "../../ops/backup/object-manifest.mjs";

const text = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

describe("Phase 8.4 backup and restore controls", () => {
  it("uses PostgreSQL custom-format tooling and refuses obvious production restores", async () => {
    const [backup, restore] = await Promise.all([text("ops/backup/backup-postgres.ps1"), text("ops/backup/restore-postgres.ps1")]);
    expect(backup).toContain("--format=custom"); expect(backup).toContain("backup-status.json"); expect(backup).toContain("Remove-Item -LiteralPath $dumpPath");
    expect(restore).toContain("TargetDatabaseUrl"); expect(restore).toContain("appears to be production"); expect(restore).not.toContain("--clean");
  });

  it("keeps durable object transfer and isolated drill boundaries explicit", async () => {
    const [copy, drill, compose, verifier] = await Promise.all([text("ops/backup/object-copy.mjs"), text("ops/backup/restore-drill.ps1"), text("compose.restore-drill.yaml"), text("ops/backup/restore-drill-verify.ts")]);
    expect(copy).toContain("content-sha256"); expect(copy).toContain("Source object integrity mismatch");
    expect(copy).toContain("if (createTargetBucket)");
    expect(drill).toContain("Invoke-Compose stop postgres-source minio-source"); expect(drill).toContain("minio-backup"); expect(drill).toContain("restore-drill-status.json");
    expect(compose).toContain("postgres-restored"); expect(compose).toContain("minio-restored"); expect(compose).toContain("postgres:16");
    expect(verifier).toContain("reconcileStaleCertificateGenerationOutbox"); expect(verifier).toContain("completedOutboxAfter.dispatched_at");
  });

  it("accepts only durable object classes and rejects retention-bounded import objects", () => {
    const durable = { objects: [{ kind: "certificate_pdf", key: "certificates/example/revision-1.pdf", sha256: "a".repeat(64), size_bytes: 10, mime_type: "application/pdf" }] };
    expect(validateDurableObjectManifest(durable)).toBe(durable);
    expect(() => validateDurableObjectManifest({ objects: [{ ...durable.objects[0], kind: "participant_import", key: "participant-imports/example/source.csv", mime_type: "text/csv" }] })).toThrow("non-durable");
    expect(() => validateDurableObjectManifest({ objects: [] })).toThrow("durable objects");
  });
});
