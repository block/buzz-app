// @vitest-environment jsdom
import { File } from "node:buffer";
import { act, cleanup, renderHook } from "@testing-library/react";
import { assert, afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import type { UploadedAttachment } from "../relay/attachments";
import { useAttachmentDraft } from "./attachment-draft";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const file = (name = "notes.txt", size = 5) =>
  Object.defineProperty(new File(["notes"], name), "size", {
    value: size,
  }) as unknown as globalThis.File;
function fixture() {
  const calls: {
    file: globalThis.File;
    channel: string;
    signal: AbortSignal;
    result: ReturnType<typeof deferred<UploadedAttachment>>;
  }[] = [];
  const upload = vi.fn(
    (file: globalThis.File, channel: string, signal: AbortSignal) => {
      const result = deferred<UploadedAttachment>();
      calls.push({ file, channel, signal, result });
      return result.promise;
    },
  );
  return {
    session: { attachments: { upload } } as unknown as RelaySession,
    calls,
    upload,
  };
}
function uploaded(name = "notes.txt"): UploadedAttachment {
  return {
    name,
    url: `https://relay.test/media/${"a".repeat(64)}.txt`,
    type: "text/plain",
    size: 5,
    sha256: "a".repeat(64),
  };
}
afterEach(cleanup);

it("queues files without starting network transfer until send preparation", async () => {
  const h = fixture();
  const draft = renderHook(() => useAttachmentDraft(h.session, "one", "one"));
  act(() => draft.result.current.store.add([file()]));
  expect(draft.result.current.items[0]?.status).toBe("queued");
  expect(draft.result.current.blocked).toBe(false);
  expect(h.upload).not.toHaveBeenCalled();

  const send = new AbortController();
  let work: Promise<readonly UploadedAttachment[]>;
  await act(async () => {
    work = draft.result.current.store.prepareForSend(send.signal);
  });
  expect(h.calls).toHaveLength(1);
  expect(draft.result.current.items[0]?.status).toBe("uploading");
  await act(async () => {
    h.calls[0]?.result.resolve(uploaded());
    expect(await work).toEqual([uploaded()]);
  });
  expect(draft.result.current.items[0]?.status).toBe("ready");
});

it("retains files across navigation and starts work only after explicit retry/send", async () => {
  const h = fixture();
  const first = renderHook(() =>
    useAttachmentDraft(h.session, "channel-one", "one"),
  );
  act(() => first.result.current.store.add([file()]));
  first.unmount();
  expect(h.upload).not.toHaveBeenCalled();

  const returned = renderHook(() =>
    useAttachmentDraft(h.session, "channel-one", "one"),
  );
  const queued = returned.result.current.items[0];
  assert.exists(queued);
  expect(queued.status).toBe("queued");
  expect(returned.result.current.blocked).toBe(false);
  act(() => returned.result.current.store.cancel());
  expect(returned.result.current.items[0]?.status).toBe("queued");
  expect(returned.result.current.blocked).toBe(false);
  act(() => returned.result.current.store.retry(queued.id));
  expect(returned.result.current.items[0]?.status).toBe("queued");
  expect(h.upload).not.toHaveBeenCalled();

  const send = new AbortController();
  let work: Promise<readonly UploadedAttachment[]>;
  await act(async () => {
    work = returned.result.current.store.prepareForSend(send.signal);
  });
  expect(h.calls).toHaveLength(1);
  await act(async () => {
    h.calls[0]?.result.resolve(uploaded());
    await work;
  });
  expect(returned.result.current.items[0]?.uploaded?.name).toBe("notes.txt");
  expect(returned.result.current.blocked).toBe(false);
});

it("reuses successful descriptors after a partial upload failure", async () => {
  const h = fixture();
  const draft = renderHook(() => useAttachmentDraft(h.session, "one", "one"));
  act(() => draft.result.current.store.add([file("1.txt"), file("2.txt")]));
  const first = new AbortController();
  let firstWork: Promise<readonly UploadedAttachment[]>;
  await act(async () => {
    firstWork = draft.result.current.store.prepareForSend(first.signal);
  });
  expect(h.calls).toHaveLength(1);
  await act(async () => {
    h.calls[0]?.result.resolve(uploaded("1.txt"));
  });
  expect(h.calls).toHaveLength(2);
  await act(async () => {
    h.calls[1]?.result.reject(new Error("relay down"));
    await expect(firstWork).rejects.toThrow("relay down");
  });
  expect(draft.result.current.items.map((item) => item.status)).toEqual([
    "ready",
    "error",
  ]);
  expect(draft.result.current.blocked).toBe(true);

  act(() =>
    draft.result.current.store.retry(draft.result.current.items[1]?.id ?? ""),
  );
  expect(draft.result.current.blocked).toBe(false);
  const retry = new AbortController();
  let retryWork: Promise<readonly UploadedAttachment[]>;
  await act(async () => {
    retryWork = draft.result.current.store.prepareForSend(retry.signal);
  });
  expect(h.calls).toHaveLength(3);
  expect(h.calls[2]?.file.name).toBe("2.txt");
  await act(async () => {
    h.calls[2]?.result.resolve(uploaded("2.txt"));
    expect(await retryWork).toEqual([uploaded("1.txt"), uploaded("2.txt")]);
  });
});

it("recovers a send abort that settles before cancellation without re-uploading ready files", async () => {
  const h = fixture();
  const draft = renderHook(() => useAttachmentDraft(h.session, "one", "one"));
  act(() =>
    draft.result.current.store.add([file("ready.txt"), file("paused.txt")]),
  );
  const send = new AbortController();
  let work: Promise<readonly UploadedAttachment[]>;
  await act(async () => {
    work = draft.result.current.store.prepareForSend(send.signal);
  });
  await act(async () => {
    h.calls[0]?.result.resolve(uploaded("ready.txt"));
  });
  expect(h.calls).toHaveLength(2);
  expect(h.calls[1]?.file.name).toBe("paused.txt");

  send.abort();
  await act(async () => {
    await expect(work).rejects.toThrow();
  });
  expect(draft.result.current.items.map((item) => item.status)).toEqual([
    "ready",
    "uploading",
  ]);

  act(() => draft.result.current.store.cancel());
  expect(draft.result.current.items.map((item) => item.status)).toEqual([
    "ready",
    "error",
  ]);
  expect(draft.result.current.blocked).toBe(true);

  act(() =>
    draft.result.current.store.retry(draft.result.current.items[1]?.id ?? ""),
  );
  expect(draft.result.current.blocked).toBe(false);
  const retry = new AbortController();
  let retryWork: Promise<readonly UploadedAttachment[]>;
  await act(async () => {
    retryWork = draft.result.current.store.prepareForSend(retry.signal);
  });
  expect(h.calls).toHaveLength(3);
  expect(h.calls[2]?.file.name).toBe("paused.txt");
  await act(async () => {
    h.calls[2]?.result.resolve(uploaded("paused.txt"));
    expect(await retryWork).toEqual([
      uploaded("ready.txt"),
      uploaded("paused.txt"),
    ]);
  });
});

it("removal and cancellation abort in-flight send preparation", async () => {
  const h = fixture();
  const draft = renderHook(() => useAttachmentDraft(h.session, "one", "one"));
  act(() => draft.result.current.store.add([file()]));
  const send = new AbortController();
  let work = Promise.reject<readonly UploadedAttachment[]>(
    new Error("prepare did not start"),
  );
  work.catch(() => {});
  await act(async () => {
    work = draft.result.current.store.prepareForSend(send.signal);
  });
  const call = h.calls[0];
  assert.exists(call);
  const item = draft.result.current.items[0];
  assert.exists(item);
  act(() => draft.result.current.store.remove(item.id));
  expect(call.signal.aborted).toBe(true);
  await expect(work).rejects.toThrow();
  expect(draft.result.current.items).toEqual([]);

  act(() => draft.result.current.store.add([file("cancel.txt")]));
  const second = new AbortController();
  await act(async () => {
    work = draft.result.current.store.prepareForSend(second.signal);
  });
  const secondCall = h.calls[1];
  assert.exists(secondCall);
  act(() => draft.result.current.store.cancel());
  expect(secondCall.signal.aborted).toBe(true);
  await expect(work).rejects.toThrow();
});

it("accepts the 500 MiB source and 1,000 MiB shared retention boundaries, not cap+1", () => {
  const h = fixture();
  const a = renderHook(() => useAttachmentDraft(h.session, "a", "a"));
  const b = renderHook(() => useAttachmentDraft(h.session, "b", "b"));
  const cap = 500 * 1024 * 1024;
  act(() => a.result.current.store.add([file("a.bin", cap)]));
  act(() => b.result.current.store.add([file("b.bin", cap)]));
  expect(h.upload).not.toHaveBeenCalled();
  expect(() => b.result.current.store.add([file("overflow.bin", 1)])).toThrow(
    /drafts are full/,
  );
  act(() => a.result.current.store.clear());
  expect(() =>
    a.result.current.store.add([file("over-source.bin", cap + 1)]),
  ).toThrow(/limit/);
  act(() =>
    a.result.current.store.add(
      Array.from({ length: 10 }, (_, i) => file(`${i}.txt`)),
    ),
  );
  expect(() => a.result.current.store.add([file()])).toThrow(/at most 10/);
  expect(a.result.current.items).toHaveLength(10);
});
