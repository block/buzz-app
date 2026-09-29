import { deferredSidebar } from "./sidebar-testing";
import { afterEach, expect, it, vi } from "vitest";
import { createSidebarState } from "./sidebar-state";
import type { SidebarApi, SidebarPage } from "./sidebar-api";
import type { SidebarJournal } from "./sidebar-journal";
const channel = "01234567-89ab-cdef-0123-456789abcdef";
const other = "11234567-89ab-cdef-0123-456789abcdef";
const account = {
  retention_seconds: 2592000,
  cutoff_ms: 0,
  imported_at_ms: null,
};
const row = (channel_id = channel) => ({
  channel_id,
  name: "room",
  channel_type: "stream",
  archived: false,
  hidden: false,
  unread: { status: "exact" as const, value: 1 },
  attention: { status: "exact" as const, value: 0 },
  latest_message_id: "a".repeat(64),
  latest_message_at: 1,
  latest_message_complete: true,
  threads: { items: [], complete: true },
});
const page = (channels = [row()]): SidebarPage => ({
  account,
  channels,
  next_cursor: null,
});
const dispose: (() => void)[] = [];
afterEach(() => {
  for (const stop of dispose.splice(0)) stop();
  vi.useRealTimers();
});
function harness() {
  let state: SidebarJournal = { pending: [], manual: [] };
  let access = true,
    visible = true;
  const api = {
    sidebar: vi.fn<SidebarApi["sidebar"]>(async () => page()),
    contexts: vi.fn<SidebarApi["contexts"]>(async (targets) => ({
      account,
      contexts: targets.map((t) => ({
        status: "available",
        through_timestamp: null,
        messages: t.message_ids.map((message_id) => ({
          message_id,
          status: "unread",
          attention: false,
        })),
      })),
    })),
    write: vi.fn<SidebarApi["write"]>(async (intents) =>
      intents.map(() => ({ status: "applied" })),
    ),
  };
  const owner = createSidebarState({
    api,
    allowed: () => access,
    visible: () => visible,
    storage: {
      update: async (change) => {
        state = structuredClone(change(state));
        return state;
      },
      close() {},
    },
  });
  dispose.push(owner.dispose);
  return {
    owner,
    api,
    journal: () => state,
    deny: () => {
      access = false;
    },
    hide: () => {
      visible = false;
    },
  };
}
it("publishes progressive pages and never converts a later failure to zero", async () => {
  const h = harness();
  h.api.sidebar
    .mockResolvedValueOnce({ ...page(), next_cursor: channel })
    .mockRejectedValueOnce(new Error("offline"));
  await h.owner.ensure();
  expect(h.owner.row(channel)?.unread).toEqual({ status: "exact", value: 1 });
  expect(h.owner.sync().status).toBe("error");
  expect(h.owner.row(other)).toBeUndefined();
  await h.owner.ensure();
  expect(h.api.sidebar).toHaveBeenCalledTimes(2);
});
it("revalidates retained omissions with a targeted snapshot before removal", async () => {
  const h = harness();
  await h.owner.ensure();
  h.api.sidebar.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([]));
  await h.owner.refresh();
  expect(h.api.sidebar.mock.calls.at(-1)?.[0]).toEqual({
    channel_ids: [channel],
  });
  expect(h.owner.row(channel)).toBeUndefined();
});
it("batches live invalidations without counting events and periodically refreshes unchanged content", async () => {
  vi.useFakeTimers();
  const h = harness();
  await h.owner.ensure();
  h.owner.invalidate(channel);
  h.owner.invalidate(channel);
  h.owner.invalidate(other);
  expect(h.api.sidebar).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(249);
  expect(h.api.sidebar).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.api.sidebar.mock.calls[1]?.[0]).toEqual({
    channel_ids: [channel, other],
  });
  await vi.advanceTimersByTimeAsync(59750);
  expect(h.api.sidebar.mock.calls[2]?.[0]).toEqual({});
});
it("fences a late fetch after clear and hides revoked state before notifying", async () => {
  const h = harness();
  let resolve: ((value: SidebarPage) => void) | undefined;
  h.api.sidebar.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const loading = h.owner.ensure();
  await vi.waitFor(() => expect(resolve).toBeDefined());
  h.owner.clear();
  resolve?.(page());
  await loading;
  expect(h.owner.row(channel)).toBeUndefined();
  expect(h.owner.sync().status).toBe("idle");
  await h.owner.ensure();
  const seen: unknown[] = [];
  h.owner.subscribe(() => seen.push(h.owner.row(channel)));
  h.deny();
  h.owner.purge();
  expect(seen).toEqual([undefined]);
});
it("unknown writes survive retry with the same operands; new arrivals are not substituted", async () => {
  const h = harness();
  await h.owner.ensure();
  h.api.write.mockResolvedValueOnce([{ status: "unknown", retryable: true }]);
  const intent = {
    type: "mark_channel_read",
    channel_id: channel,
    message_id: "a".repeat(64),
  } as const;
  await h.owner.enqueue(
    [{ intent, createdAt: 1 }],
    () => false,
    () => true,
  );
  await vi.waitFor(() => expect(h.owner.sync().status).toBe("error"));
  expect(h.journal().pending).toHaveLength(1);
  await h.owner.retry();
  expect(h.api.write.mock.calls.map((c) => c[0])).toEqual([[intent], [intent]]);
  expect(h.journal().pending).toEqual([]);
});
it("coalesces mounted context demand into bounded requests", async () => {
  const h = harness();
  await Promise.all(
    Array.from(
      { length: 25 },
      (_, i) =>
        h.owner.retain({
          target: {
            channel_id: channel,
            root_id: i.toString(16).padStart(64, "0"),
          },
          message_ids: [],
        }).ready,
    ),
  );
  expect(h.api.contexts.mock.calls.map((c) => c[0].length)).toEqual([20, 5]);
});

it("writes a durable fixed cut while a sidebar read is held", async () => {
  const h = harness();
  const held = deferredSidebar<SidebarPage>();
  h.api.sidebar.mockImplementationOnce(() => held.promise);
  const reading = h.owner.ensure();
  try {
    await vi.waitFor(() => expect(h.api.sidebar).toHaveBeenCalledTimes(1));
    await h.owner.enqueue(
      [
        {
          intent: {
            type: "mark_channel_read",
            channel_id: channel,
            message_id: "b".repeat(64),
          },
          createdAt: 1,
        },
      ],
      () => false,
      () => true,
    );
    await vi.waitFor(() => expect(h.api.write).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(h.journal().pending).toEqual([]));
  } finally {
    held.resolve(page());
    await reading;
  }
});

it("releases selectors independently and refreshes only dirty channels", async () => {
  vi.useFakeTimers();
  const h = harness();
  await h.owner.ensure();
  const a = h.owner.retain({
    target: { channel_id: channel },
    message_ids: ["a".repeat(64)],
  });
  const b = h.owner.retain({
    target: { channel_id: channel },
    message_ids: ["b".repeat(64)],
  });
  const c = h.owner.retain({
    target: { channel_id: other },
    message_ids: ["c".repeat(64)],
  });
  await Promise.all([a.ready, b.ready, c.ready]);
  a.dispose();
  h.api.contexts.mockClear();
  h.owner.invalidate(channel);
  await vi.advanceTimersByTimeAsync(250);
  expect(h.api.contexts.mock.calls.map(([queries]) => queries)).toEqual([
    [{ target: { channel_id: channel }, message_ids: ["b".repeat(64)] }],
  ]);
  b.dispose();
  c.dispose();
  expect(h.owner.context({ channel_id: channel })).toBeUndefined();
  h.api.contexts.mockClear();
  await h.owner.refresh();
  expect(h.api.contexts).not.toHaveBeenCalled();
});

it("does not reinstall a released context from a late response", async () => {
  const h = harness();
  const held = deferredSidebar<Awaited<ReturnType<SidebarApi["contexts"]>>>();
  h.api.contexts.mockImplementationOnce(() => held.promise);
  const lease = h.owner.retain({
    target: { channel_id: channel },
    message_ids: ["a".repeat(64)],
  });
  await vi.waitFor(() => expect(h.api.contexts).toHaveBeenCalledTimes(1));
  lease.dispose();
  held.resolve({
    account,
    contexts: [
      {
        status: "available",
        through_timestamp: null,
        messages: [
          { message_id: "a".repeat(64), status: "unread", attention: true },
        ],
      },
    ],
  });
  await lease.ready;
  expect(h.owner.context({ channel_id: channel })).toBeUndefined();
});

it("recycles capacity through more than 1000 sequential mounted selectors", async () => {
  const h = harness();
  for (let i = 0; i < 1001; i++) {
    const lease = h.owner.retain({
      target: { channel_id: channel },
      message_ids: [i.toString(16).padStart(64, "0")],
    });
    await lease.ready;
    lease.dispose();
  }
  expect(h.api.contexts).toHaveBeenCalledTimes(1001);
  expect(h.owner.context({ channel_id: channel })).toBeUndefined();
});

it.each(["blocked", "invalid"] as const)(
  "reports terminal %s only on the affected channel",
  async (status) => {
    const h = harness();
    await h.owner.ensure();
    h.api.write.mockResolvedValueOnce([{ status }]);
    await h.owner.enqueue(
      [
        {
          intent: {
            type: "mark_channel_read",
            channel_id: channel,
            message_id: "a".repeat(64),
          },
          createdAt: 1,
        },
      ],
      () => false,
      () => true,
    );
    await vi.waitFor(() =>
      expect(h.owner.operationError(channel)).toContain(status),
    );
    expect(h.owner.sync().status).toBe("ready");
    expect(h.owner.operationError(other)).toBeUndefined();
    expect(h.journal().pending).toEqual([]);
  },
);

it("does not overwrite a failed context pass with successful sidebar readiness", async () => {
  const h = harness();
  h.api.contexts.mockRejectedValue(new Error("contexts unavailable"));
  const lease = h.owner.retain({
    target: { channel_id: channel },
    message_ids: ["a".repeat(64)],
  });
  await lease.ready;
  await h.owner.ensure();
  expect(h.owner.sync()).toMatchObject({
    status: "error",
    error: "contexts unavailable",
  });
  lease.dispose();
});

it("bounds bulk demand, preserves strict admission errors and recycles released capacity", async () => {
  const h = harness();
  const ids = Array.from({ length: 1100 }, (_, i) =>
    i.toString(16).padStart(64, "0"),
  );
  const first = h.owner.retain(
    { target: { channel_id: channel }, message_ids: ids },
    true,
  );
  await first.ready;
  const initial = h.owner.context({ channel_id: channel });
  expect(initial?.status === "available" && initial.messages.length).toBe(500);
  const second = h.owner.retain({
    target: { channel_id: other },
    message_ids: ids.slice(500, 1000),
  });
  await second.ready;
  const shared = h.owner.retain({
    target: { channel_id: channel },
    message_ids: ["0".repeat(64)],
  });
  await shared.ready;
  expect(() =>
    h.owner.retain({
      target: { channel_id: other },
      message_ids: ids.slice(1000),
    }),
  ).toThrow("capacity");
  const overflow = h.owner.retain(
    { target: { channel_id: other }, message_ids: ids.slice(1000) },
    true,
  );
  await overflow.ready;
  first.dispose();
  const retained = h.owner.context({ channel_id: channel });
  expect(
    retained?.status === "available" &&
      retained.messages.map((m) => m.message_id),
  ).toEqual([ids[0]]);
  shared.dispose();
  second.dispose();
  overflow.dispose();
  const reclaimed = h.owner.retain({
    target: { channel_id: other },
    message_ids: ids.slice(1000),
  });
  await reclaimed.ready;
  expect(h.owner.context({ channel_id: channel })).toBeUndefined();
  const next = h.owner.context({ channel_id: other });
  expect(next?.status === "available" && next.messages.length).toBe(100);
  reclaimed.dispose();
});
