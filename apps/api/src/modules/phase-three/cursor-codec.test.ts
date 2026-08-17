import { describe, expect, it } from "vitest";

import { CursorCodec } from "./cursor-codec.js";

const organizationId = "00000000-0000-4000-8000-000000000001";

describe("opaque admin cursor", () => {
  it("round-trips a scoped cursor without exposing raw query state", () => {
    const codec = new CursorCodec("cursor-secret-at-least-32-bytes-value");
    const cursor = codec.encode({ organizationId, resource: "projects", createdAt: new Date("2026-08-18T00:00:00Z"),
      id: "00000000-0000-4000-8000-000000000002" });
    expect(cursor).not.toContain(organizationId);
    expect(codec.decode(cursor, organizationId, "projects")).toEqual({
      createdAt: new Date("2026-08-18T00:00:00Z"), id: "00000000-0000-4000-8000-000000000002"
    });
  });

  it("rejects tampering and cross-resource replay", () => {
    const codec = new CursorCodec("cursor-secret-at-least-32-bytes-value");
    const cursor = codec.encode({ organizationId, resource: "projects", createdAt: new Date(),
      id: "00000000-0000-4000-8000-000000000002" });
    expect(() => codec.decode(`${cursor.slice(0, -1)}A`, organizationId, "projects")).toThrow();
    expect(() => codec.decode(cursor, organizationId, "trainings")).toThrow();
  });
});
