import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { MigrationBuilder } from "node-pg-migrate";

import { down, up } from "../migrations/202608170001_initial-canonical-schema.js";

const EXPECTED_SCHEMA_SHA256 = "1353deed1f285e8f30b713b76c3d7c0b0d79f2c3145ce5fc13bacb77ecd969a0";
const hash = (contents: string): string => createHash("sha256").update(contents).digest("hex");

describe("initial migration schema snapshot", () => {
  it("matches the canonical Phase 0 schema exactly", () => {
    const canonical = readFileSync(new URL("../../../docs/09-postgresql-schema.sql", import.meta.url), "utf8");
    const snapshot = readFileSync(new URL("../schema/0001-canonical-schema.sql", import.meta.url), "utf8");

    expect(snapshot).toBe(canonical);
    expect(hash(snapshot)).toBe(EXPECTED_SCHEMA_SHA256);
  });

  it("passes only the verified snapshot to node-pg-migrate", () => {
    const sql = vi.fn();
    const migrationBuilder = { sql } as unknown as MigrationBuilder;
    const canonical = readFileSync(new URL("../../../docs/09-postgresql-schema.sql", import.meta.url), "utf8");

    up(migrationBuilder);

    expect(sql).toHaveBeenCalledOnce();
    expect(sql).toHaveBeenCalledWith(canonical);
  });

  it("defines a reversible teardown without removing a pre-existing pgcrypto extension", () => {
    const sql = vi.fn();

    down({ sql } as unknown as MigrationBuilder);

    const teardown = String(sql.mock.calls[0]?.[0]);
    expect(teardown).toContain("DROP TABLE IF EXISTS");
    expect(teardown).toContain("DROP TYPE IF EXISTS record_status");
    expect(teardown).not.toContain("DROP EXTENSION");
  });
});
