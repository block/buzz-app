import { deferredSidebar } from "./sidebar-testing";
import { afterEach, expect, it, vi } from "vitest";
import { ReadError } from "./errors";
import { createSidebarState } from "./sidebar-state";
import type { SidebarApi, SidebarPage } from "./sidebar-api";
import type { SidebarJournal } from "./sidebar-journal";
const channel = "01234567-89ab-cdef-0123-456789abcdef";
const other = "11234567-89ab-cdef-0123-456789abcdef";
const account = {
  retention_seconds: 2592000,
  cutoff_ms: 0,
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
const page = (channels: SidebarPage["channels"] = [row()]): SidebarPage => ({
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
  let rejectAcknowledgementAt: number | undefined;
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
        const next = change(state);
        if (
          rejectAcknowledgementAt === state.pending.length &&
          next.pending.length < state.pending.length
        ) {
          rejectAcknowledgementAt = undefined;
          throw new Error("acknowledgement storage failed");
        }
        state = structuredClone(next);
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
    rejectAcknowledgementAt: (pending: number) => {
      rejectAcknowledgementAt = pending;
    },
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
it.each([
  ["read", "write"],
  ["write", "read"],
] as const)(
  "paces its own %s requests by the relay's Retry-After while %s requests continue",
  async (refused, free) => {
    vi.useFakeTimers();
    const h = harness();
    await h.owner.ensure();
    await vi.waitFor(() => expect(h.owner.sync().status).toBe("ready"));
    const calls = { read: h.api.sidebar, write: h.api.write };
    const attempt = async (lane: "read" | "write") => {
      if (lane === "read") h.owner.invalidate(channel);
      else
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
      await vi.advanceTimersByTimeAsync(250);
    };
    const before = calls[refused].mock.calls.length;
    calls[refused].mockRejectedValueOnce(
      new ReadError("unavailable", "refused", 503, 17000),
    );
    await attempt(refused);
    expect(calls[refused]).toHaveBeenCalledTimes(before + 1);
    expect(h.owner.sync().error).toBe("refused");
    await attempt(refused);
    expect(calls[refused]).toHaveBeenCalledTimes(before + 1);
    const freeBefore = calls[free].mock.calls.length;
    await attempt(free);
    expect(calls[free].mock.calls.length).toBeGreaterThan(freeBefore);
    expect(calls[refused]).toHaveBeenCalledTimes(before + 1);
    await vi.advanceTimersByTimeAsync(16250);
    await attempt(refused);
    expect(calls[refused].mock.calls.length).toBeGreaterThan(before + 1);
  },
);
it("coalesces expired invalidation windows behind one in-flight targeted read", async () => {
  vi.useFakeTimers();
  const h = harness();
  await h.owner.ensure();
  const held = deferredSidebar<SidebarPage>();
  const followup = deferredSidebar<void>();
  let targeted = 0;
  const updated = { ...row(other), latest_message_id: "b".repeat(64) };
  h.api.sidebar.mockClear();
  h.api.sidebar.mockImplementation(async (query) => {
    if (!("channel_ids" in query))
      return page([row(), h.owner.row(other) ?? row(other)]);
    targeted++;
    if (targeted === 1) return held.promise;
    followup.resolve();
    return page([row(), updated]);
  });
  h.owner.invalidate(channel);
  await vi.advanceTimersByTimeAsync(250);
  try {
    expect(targeted).toBe(1);
    for (let i = 0; i < 4; i++) {
      h.owner.invalidate(channel);
      h.owner.invalidate(other);
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(targeted).toBe(1);
  } finally {
    held.resolve(page());
  }
  // A traversal queued behind the held request is a barrier: a read queued per
  // window would have run by now. The one follow-up waits for its own window.
  await h.owner.refresh();
  expect(targeted).toBe(1);
  await vi.advanceTimersByTimeAsync(250);
  await followup.promise;
  await h.owner.refresh();
  expect(
    h.api.sidebar.mock.calls.flatMap(([query]) =>
      "channel_ids" in query ? [query.channel_ids] : [],
    ),
  ).toEqual([[channel], [channel, other]]);
  expect(h.owner.row(other)?.latest_message_id).toBe(updated.latest_message_id);
});
it.each(["dispose", "clear", "purge"] as const)(
  "does not continue a held targeted drain after %s",
  async (action) => {
    vi.useFakeTimers();
    const h = harness();
    await h.owner.ensure();
    const held = deferredSidebar<SidebarPage>();
    h.api.sidebar.mockClear();
    h.api.sidebar.mockImplementation(() => held.promise);
    h.owner.invalidate(channel);
    await vi.advanceTimersByTimeAsync(250);
    expect(h.api.sidebar).toHaveBeenCalledTimes(1);
    h.owner.invalidate(other);
    await vi.advanceTimersByTimeAsync(250);
    if (action === "purge") h.deny();
    h.owner[action]();
    const seen: unknown[] = [];
    const stop = h.owner.subscribe(() => seen.push(h.owner.row(other)));
    try {
      held.resolve(page([row(other)]));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.api.sidebar).toHaveBeenCalledTimes(1);
      expect(h.owner.row(other)).toBeUndefined();
      expect(seen.every((value) => value === undefined)).toBe(true);
    } finally {
      stop();
      held.resolve(page([]));
    }
  },
);
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

it("bounds selector demand, surfaces admission errors and recycles released capacity", async () => {
  const h = harness();
  const ids = Array.from({ length: 1100 }, (_, i) =>
    i.toString(16).padStart(64, "0"),
  );
  const first = h.owner.retain({
    target: { channel_id: channel },
    message_ids: ids.slice(0, 500),
  });
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
  first.dispose();
  const retained = h.owner.context({ channel_id: channel });
  expect(
    retained?.status === "available" &&
      retained.messages.map((m) => m.message_id),
  ).toEqual([ids[0]]);
  shared.dispose();
  second.dispose();
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

it("batches independent context anchors at the 100-intent limit", async () => {
  const h = harness();
  const intents = Array.from({ length: 201 }, (_, n) => ({
    createdAt: n,
    intent: {
      type: "mark_through" as const,
      target: {
        channel_id: channel,
        root_id: n.toString(16).padStart(64, "0"),
      },
      message_id: "a".repeat(64),
    },
  }));
  await h.owner.journal.enqueue(
    intents,
    () => false,
    () => true,
  );
  await h.owner.retry();
  expect(h.api.write.mock.calls.map(([batch]) => batch.length)).toEqual([
    100, 100, 1,
  ]);
  expect(h.journal().pending).toEqual([]);
});

it("saturated applied presentation retains the whole next batch and schedules recovery", async () => {
  vi.useFakeTimers();
  const h = harness();
  await h.owner.ensure();
  const reads = Array.from({ length: 1000 }, (_, i) => ({
    createdAt: 1,
    intent: {
      type: "mark_through" as const,
      target: {
        channel_id: channel,
        root_id: i.toString(16).padStart(64, "0"),
      },
      message_id: "a".repeat(64),
    },
  }));
  await h.owner.journal.enqueue(
    reads,
    () => false,
    () => true,
  );
  // Flush without advancing the invalidation timer; unresolved overlays fill capacity.
  await h.owner.ensure();
  await vi.advanceTimersByTimeAsync(0);
  // ensure's first flush may predate enqueue, so explicitly retry with a held read.
  const held = deferredSidebar<SidebarPage>();
  h.api.sidebar.mockImplementationOnce(() => held.promise);
  const first = h.owner.retry();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.journal().pending).toHaveLength(0);
  const next = {
    createdAt: 2,
    intent: {
      type: "mark_through" as const,
      target: { channel_id: channel, root_id: "f".repeat(64) },
      message_id: "b".repeat(64),
    },
  };
  await h.owner.enqueue(
    [next],
    () => false,
    () => true,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(h.journal().pending).toHaveLength(1);
  expect(h.owner.sync().error).toContain("reconciliation scheduled");
  held.resolve(page());
  await first;
  await vi.advanceTimersByTimeAsync(250);
  await h.owner.retry();
  expect(h.journal().pending).toHaveLength(0);
});

const capacityReads = (count: number, start = 0) =>
  Array.from({ length: count }, (_, offset) => ({
    createdAt: 1,
    intent: {
      type: "mark_through" as const,
      target: {
        channel_id: channel,
        root_id: (start + offset).toString(16).padStart(64, "0"),
      },
      message_id: "a".repeat(64),
    },
  }));

it("retries already-applied IDs at capacity after failed journal acknowledgement without resetting surfaces or revision", async () => {
  vi.useFakeTimers();
  const h = harness();
  await h.owner.ensure();
  const target = {
    channel_id: channel,
    root_id: (999).toString(16).padStart(64, "0"),
  };
  // A mounted unresolved message prevents pruning even after sidebar settlement.
  h.api.contexts.mockImplementation(async (queries) => ({
    account,
    contexts: queries.map((q) => ({
      status: "available",
      through_timestamp: null,
      messages: q.message_ids.map((message_id) => ({
        message_id,
        status: "unknown",
      })),
    })),
  }));
  const lease = h.owner.retain({ target, message_ids: ["a".repeat(64)] });
  await lease.ready;
  h.rejectAcknowledgementAt(100);
  await h.owner.enqueue(
    capacityReads(1000),
    () => false,
    () => true,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(h.owner.sync().error).toBe("acknowledgement storage failed");
  const pending = h.journal().pending;
  expect(pending).toHaveLength(100);
  expect(h.owner.covered(target, 1, false, "a".repeat(64))).toBe(true);
  // This response starts after original application but before the same-ID retry.
  const held = deferredSidebar<SidebarPage>();
  h.api.sidebar.mockImplementationOnce(() => held.promise);
  const refresh = h.owner.refresh();
  await vi.advanceTimersByTimeAsync(0);
  const retry = h.owner.retry();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.api.write.mock.calls.at(-1)?.[0]).toEqual(
    pending.map((p) => p.intent),
  );
  expect(h.journal().pending).toHaveLength(0);
  expect(h.owner.covered(target, 1, false, "a".repeat(64))).toBe(true);
  const summary = {
    ...row(),
    threads: {
      complete: true,
      items: [
        {
          root_id: target.root_id,
          latest_reply_id: "a".repeat(64),
          latest_reply_at: 1,
          unread: { status: "exact" as const, value: 1 },
          attention: { status: "exact" as const, value: 0 },
        },
      ],
    },
  };
  held.resolve(page([summary]));
  await Promise.all([refresh, retry]);
  // Reusing the ID preserves its old revision: this response can settle summary,
  // while the unknown selected message still retains its independent coverage.
  expect(h.owner.covered(target, 1)).toBe(false);
  expect(h.owner.covered(target, 1, false, "a".repeat(64))).toBe(true);
  lease.dispose();
});

it.each(["applied", "blocked"] as const)(
  "admits none of a two-operand overflow with one slot left, then recovers with %s",
  async (outcome) => {
    vi.useFakeTimers();
    const h = harness();
    await h.owner.ensure();
    await h.owner.enqueue(
      capacityReads(999),
      () => false,
      () => true,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(h.journal().pending).toHaveLength(0);
    const next = capacityReads(2, 1000);
    await h.owner.enqueue(
      next,
      () => false,
      () => true,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(h.owner.sync().error).toContain("presentation capacity");
    expect(h.journal().pending.map((p) => p.intent)).toEqual(
      next.map((p) => p.intent),
    );
    for (const read of next)
      expect(h.owner.covered(read.intent.target, 1)).toBe(true);
    if (outcome === "applied") {
      // Applicable refresh frees the old entries; the complete batch can retry.
      await vi.advanceTimersByTimeAsync(250);
    } else {
      // A terminal retry must remove both pending masks. A partially admitted
      // first operand would leak coverage after the journal removes that operand.
      h.api.write.mockResolvedValueOnce([
        { status: "blocked" },
        { status: "blocked" },
      ]);
    }
    const held = deferredSidebar<SidebarPage>();
    h.api.sidebar.mockImplementationOnce(() => held.promise);
    const retry = h.owner.retry();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(h.journal().pending).toHaveLength(0);
      if (outcome === "blocked") {
        // Check BEFORE a successful read could hide a leaked applied operand.
        for (const read of next)
          expect(h.owner.covered(read.intent.target, 1)).toBe(false);
        expect(h.owner.operationError(channel)).toContain("blocked");
      } else {
        expect(h.api.write.mock.calls.at(-1)?.[0]).toEqual(
          next.map((p) => p.intent),
        );
      }
    } finally {
      held.resolve(page());
      await retry;
    }
  },
);
