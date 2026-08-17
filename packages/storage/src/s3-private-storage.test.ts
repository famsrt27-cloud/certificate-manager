import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { PrivateObjectTooLargeError, createPrivateObjectStorage } from "./s3-private-storage.js";

describe("private S3-compatible storage", () => {
  it("writes objects without a public ACL or URL", async () => {
    const send = vi.fn().mockResolvedValue({});
    const storage = createPrivateObjectStorage({ send } as never, "private-imports");

    await storage.put({
      key: "participant-imports/org/job/source.csv",
      body: Buffer.from("display_name\nSynthetic Person"),
      contentType: "text/csv",
      contentSha256Hex: "a".repeat(64)
    });

    const command = send.mock.calls[0]?.[0] as { input: Record<string, unknown> };
    expect(command.input).not.toHaveProperty("ACL");
    expect(command.input).not.toHaveProperty("WebsiteRedirectLocation");
  });

  it("rejects an object whose declared length exceeds the bounded read", async () => {
    const send = vi.fn().mockResolvedValue({
      ContentLength: 101,
      Body: Readable.from([])
    });
    const storage = createPrivateObjectStorage({ send } as never, "private-imports");

    await expect(storage.get("private-key", 100)).rejects.toBeInstanceOf(PrivateObjectTooLargeError);
  });
});
