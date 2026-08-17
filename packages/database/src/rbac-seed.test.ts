import { describe, expect, it, vi } from "vitest";

import type { MigrationBuilder } from "node-pg-migrate";

import { down, up } from "../migrations/202608180002_seed-rbac.js";

describe("RBAC seed migration", () => {
  it("seeds reviewed system and organization role scopes and every canonical permission", () => {
    const sql = vi.fn();
    up({ sql } as unknown as MigrationBuilder);

    const statement = String(sql.mock.calls[0]?.[0]);
    expect(statement).toContain("('SUPER_ADMIN', 'SYSTEM'");
    expect(statement).toContain("('ORG_ADMIN', 'ORGANIZATION'");
    expect(statement).toContain("'role:assign'");
    expect(statement).toContain("'security:read'");
  });

  it("has a bounded rollback for seed data only", () => {
    const sql = vi.fn();
    down({ sql } as unknown as MigrationBuilder);

    const statement = String(sql.mock.calls[0]?.[0]);
    expect(statement).toContain("DELETE FROM role_permissions");
    expect(statement).not.toContain("DROP TABLE");
  });
});
