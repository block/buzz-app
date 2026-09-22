import { expect, it, vi } from "vitest";
import { createAttachmentQueue } from "./attachment-queue";
import { UploadError } from "../relay/attachments";
const file = (name: string) => new File(["x"], name, { type: "text/plain" });
const result = {
  url: `https://relay.test/media/${"a".repeat(64)}.txt`,
  type: "text/plain",
  size: 1,
  sha256: "a".repeat(64),
};
it("bounds concurrency, preserves order and retries only the failed file", async () => {
  const calls: {
    resolve: (value: typeof result) => void;
    reject: (error: Error) => void;
    signal: AbortSignal;
  }[] = [];
  const upload = vi.fn(
    (_file, signal) =>
      new Promise<typeof result>((resolve, reject) =>
        calls.push({ resolve, reject, signal }),
      ),
  );
  const queue = createAttachmentQueue(upload);
  try {
    queue.add([file("a.txt"), file("b.txt"), file("c.txt")]);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(queue.snapshot().map((x) => x.state)).toEqual([
      "uploading",
      "uploading",
      "queued",
    ]);
    expect(() => queue.content("draft")).toThrow(/Wait/);
    calls[0]?.resolve(result);
    calls[1]?.reject(new UploadError("metadata"));
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    calls[2]?.resolve(result);
    await vi.waitFor(() =>
      expect(queue.snapshot().map((x) => x.state)).toEqual([
        "ready",
        "failed",
        "ready",
      ]),
    );
    queue.retry(2);
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    calls[3]?.resolve(result);
    await vi.waitFor(() =>
      expect(queue.snapshot().every((x) => x.state === "ready")).toBe(true),
    );
    expect(queue.content("  @Person")).toMatch(/^ {2}@Person\n\n\[a.txt\]/);
    expect(queue.content("").indexOf("a.txt")).toBeLessThan(
      queue.content("").indexOf("b.txt"),
    );
    expect(upload).toHaveBeenCalledTimes(4);
  } finally {
    queue.dispose();
  }
});
it("removal/disposal cancel and reject late completion", async () => {
  let resolve = (_value: typeof result) => {};
  const promise = new Promise<typeof result>((done) => {
    resolve = done;
  });
  const pending = { promise, resolve };
  let signal: AbortSignal | undefined;
  const queue = createAttachmentQueue(async (_file, value) => {
    signal = value;
    return pending.promise;
  });
  queue.add([file("a.txt")]);
  await vi.waitFor(() => expect(signal).toBeDefined());
  queue.remove(1);
  expect(signal?.aborted).toBe(true);
  pending.resolve(result);
  await pending.promise;
  expect(queue.snapshot()).toEqual([]);
  queue.dispose();
  expect(queue.add([file("b")])).toBe("This composer is closed.");
});
it("rejects oversized batches without starting any upload", () => {
  const upload = vi.fn();
  const queue = createAttachmentQueue(upload);
  expect(queue.add(Array.from({ length: 11 }, () => file("x")))).toContain(
    "10",
  );
  expect(queue.add([new File([], "empty")])).toContain("20 MB");
  expect(upload).not.toHaveBeenCalled();
  queue.dispose();
});
