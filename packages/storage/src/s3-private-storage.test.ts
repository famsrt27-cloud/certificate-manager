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

  it("stops an undeclared stream as soon as its cumulative bytes cross the bound", async () => {
    const body = Readable.from([Buffer.alloc(60), Buffer.alloc(60), Buffer.alloc(60)]);
    const destroy = vi.spyOn(body, "destroy");
    const send = vi.fn().mockResolvedValue({ Body: body });
    const storage = createPrivateObjectStorage({ send } as never, "private-imports");

    await expect(storage.get("private-key", 100)).rejects.toBeInstanceOf(PrivateObjectTooLargeError);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("returns an undeclared stream when the exact cumulative bound is respected", async () => {
    const send = vi.fn().mockResolvedValue({ Body: Readable.from([Buffer.from("abc"), Buffer.from("def")]) });
    const storage = createPrivateObjectStorage({ send } as never, "private-imports");

    await expect(storage.get("private-key", 6)).resolves.toEqual(Buffer.from("abcdef"));
  });

  it("reports aggregate storage failures without exposing the object key", async () => {
    const observer = { onFailure: vi.fn() };
    const storage = createPrivateObjectStorage({ send: vi.fn().mockRejectedValue(new Error("private key detail")) } as never,
      "private-imports", observer);

    await expect(storage.get("private-key-must-not-be-reported", 6)).rejects.toThrow("private key detail");
    expect(observer.onFailure).toHaveBeenCalledOnce();
    expect(JSON.stringify(observer.onFailure.mock.calls)).not.toContain("private-key-must-not-be-reported");
  });
});
