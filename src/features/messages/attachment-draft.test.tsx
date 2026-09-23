// @vitest-environment jsdom
import { File } from "node:buffer";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { assert, afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import type { UploadedAttachment } from "../relay/attachments";
import { useAttachmentDraft } from "./attachment-draft";

const deferred = <T,>() => Promise.withResolvers<T>();
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

it("retains files across navigation, pauses work, and fences late completion before explicit retry", async () => {
  const h = fixture();
  const first = renderHook(() =>
    useAttachmentDraft(h.session, "channel-one", "one"),
  );
  act(() => first.result.current.store.add([file()]));
  await waitFor(() => expect(h.calls).toHaveLength(1));
  first.unmount();
  assert.exists(h.calls[0]);
  expect(h.calls[0].signal.aborted).toBe(true);
  const returned = renderHook(() =>
    useAttachmentDraft(h.session, "channel-one", "one"),
  );
  const paused = returned.result.current.items[0];
  assert.exists(paused);
  expect(paused.status).toBe("error");
  expect(paused.file.name).toBe("notes.txt");
  expect(returned.result.current.blocked).toBe(true);
  act(() => returned.result.current.store.retry(paused.id));
  await waitFor(() => expect(h.calls).toHaveLength(2));
  const [firstCall, retryCall] = h.calls;
  assert.exists(firstCall);
  assert.exists(retryCall);
  await act(async () => {
    firstCall.result.resolve(uploaded("stale.txt"));
  });
  expect(returned.result.current.items[0]?.status).toBe("uploading");
  await act(async () => {
    retryCall.result.resolve(uploaded());
  });
  expect(returned.result.current.items[0]?.uploaded?.name).toBe("notes.txt");
  expect(returned.result.current.blocked).toBe(false);
  expect(h.calls.map((call) => call.channel)).toEqual(["one", "one"]);
});

it("bounds concurrency and removal cancels a file without letting its late result return", async () => {
  const h = fixture();
  const draft = renderHook(() => useAttachmentDraft(h.session, "one", "one"));
  act(() =>
    draft.result.current.store.add([
      file("1.txt"),
      file("2.txt"),
      file("3.txt"),
    ]),
  );
  await waitFor(() => expect(h.calls).toHaveLength(2));
  const item = draft.result.current.items[0];
  assert.exists(item);
  assert.exists(h.calls[0]);
  const removed = item.id;
  act(() => draft.result.current.store.remove(removed));
  expect(h.calls[0].signal.aborted).toBe(true);
  await waitFor(() => expect(h.calls).toHaveLength(3));
  await act(async () => {
    for (const call of h.calls) call.result.resolve(uploaded(call.file.name));
  });
  expect(draft.result.current.items.map((item) => item.file.name)).toEqual([
    "2.txt",
    "3.txt",
  ]);
  expect(draft.result.current.blocked).toBe(false);
  act(() => draft.result.current.store.clear());
  expect(draft.result.current.items).toEqual([]);
});

it("accepts the 500 MiB source and 1,000 MiB shared retention boundaries, not cap+1", () => {
  const h = fixture();
  const a = renderHook(() => useAttachmentDraft(h.session, "a", "a"));
  const b = renderHook(() => useAttachmentDraft(h.session, "b", "b"));
  const cap = 500 * 1024 * 1024;
  act(() => a.result.current.store.add([file("a.bin", cap)]));
  act(() => b.result.current.store.add([file("b.bin", cap)]));
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
