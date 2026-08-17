import { describe, expect, it, vi } from "vitest";

import { closeDatabase } from "./database.js";

describe("database lifecycle", () => {
  it("destroys the Kysely instance during shutdown", async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);

    await closeDatabase({ destroy } as never);

    expect(destroy).toHaveBeenCalledOnce();
  });
});
