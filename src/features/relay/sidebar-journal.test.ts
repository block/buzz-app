import { expect, it } from "vitest";
import {
  createSidebarJournal,
  type SidebarJournal,
  type SidebarStorage,
} from "./sidebar-journal";
const channel = "01234567-89ab-cdef-0123-456789abcdef";
const target = { kind: "channel", channelId: channel } as const;
const intent = {
  type: "mark_channel_read",
  channel_id: channel,
  message_id: "a".repeat(64),
} as const;
function storage() {
  let state: SidebarJournal = { pending: [], manual: [] };
  let fail = false;
  const storage: SidebarStorage = {
    update: async (change) => {
      if (fail) throw new Error("disk unavailable");
      state = structuredClone(change(structuredClone(state)));
      return structuredClone(state);
    },
    close() {},
  };
  return {
    storage,
    read: () => state,
    fail: () => {
      fail = true;
    },
  };
}
it("atomically persists fixed operands and explicit manual clears", async () => {
  const s = storage(),
    journal = createSidebarJournal(s.storage, () => {});
  await journal.markUnread(target, () => true);
  const result = await journal.enqueue(
    [{ intent, createdAt: 1 }],
    () => true,
    () => true,
  );
  expect(result).toMatchObject({ durability: "saved", sync: "pending" });
  expect(s.read()).toEqual({
    pending: [{ id: result.operationId, intent, createdAt: 1 }],
    manual: [],
  });
  const reloaded = createSidebarJournal(s.storage, () => {});
  await reloaded.reload();
  expect(reloaded.snapshot()).toEqual(journal.snapshot());
});
it("failed persistence and cancelled queued intent change neither half", async () => {
  const s = storage(),
    journal = createSidebarJournal(s.storage, () => {});
  await journal.markUnread(target, () => true);
  await expect(
    journal.enqueue(
      [{ intent, createdAt: 1 }],
      () => true,
      () => false,
    ),
  ).rejects.toThrow("context changed");
  expect(journal.manual(target)).toBe(true);
  s.fail();
  await expect(
    journal.enqueue(
      [{ intent, createdAt: 1 }],
      () => true,
      () => true,
    ),
  ).rejects.toThrow("disk unavailable");
  expect(s.read()).toEqual({ pending: [], manual: [target] });
});
it("retains unknown outcomes and never erases another window's pending intent", async () => {
  const s = storage(),
    a = createSidebarJournal(s.storage, () => {}),
    b = createSidebarJournal(s.storage, () => {});
  await a.enqueue(
    [{ intent, createdAt: 1 }],
    () => false,
    () => true,
  );
  const sent = a.snapshot().pending;
  await b.enqueue(
    [
      {
        intent: {
          ...intent,
          channel_id: "11234567-89ab-cdef-0123-456789abcdef",
          message_id: "b".repeat(64),
        },
        createdAt: 2,
      },
    ],
    () => false,
    () => true,
  );
  await a.acknowledge(sent, [{ status: "unknown", retryable: true }]);
  expect(s.read().pending).toHaveLength(2);
  await a.acknowledge(sent, [{ status: "applied" }]);
  expect(s.read().pending.map((p) => p.intent.message_id)).toEqual([
    "b".repeat(64),
  ]);
  await b.reload();
  expect(b.snapshot()).toEqual(a.snapshot());
});
it.each(["blocked", "invalid"] as const)(
  "resolves terminal %s without retrying it",
  async (status) => {
    const s = storage(),
      journal = createSidebarJournal(s.storage, () => {});
    await journal.enqueue(
      [{ intent, createdAt: 1 }],
      () => false,
      () => true,
    );
    await journal.acknowledge(journal.snapshot().pending, [{ status }]);
    expect(s.read().pending).toEqual([]);
  },
);

it("coalesces monotone same-context and whole-channel cuts, preserving independent contexts and newer anchors", async () => {
  const s = storage(),
    journal = createSidebarJournal(s.storage, () => {});
  const mark = (root: string | undefined, at: number) => ({
    createdAt: at,
    intent: {
      type: "mark_through" as const,
      target: { channel_id: channel, ...(root ? { root_id: root } : {}) },
      message_id: at.toString(16).padStart(64, "0"),
    },
  });
  const add = (anchors: Parameters<typeof journal.enqueue>[0]) =>
    journal.enqueue(
      anchors,
      () => false,
      () => true,
    );
  await add([
    mark(undefined, 1),
    mark("b".repeat(64), 2),
    mark("c".repeat(64), 8),
  ]);
  await add([mark(undefined, 3), mark(undefined, 2)]);
  expect(s.read().pending.map((p) => p.createdAt)).toEqual([2, 8, 3]);
  const captured = [...s.read().pending];
  await add([{ intent, createdAt: 5 }]);
  expect(s.read().pending.map((p) => p.createdAt)).toEqual([8, 5]);
  await journal.acknowledge(
    captured,
    captured.map(() => ({ status: "applied" })),
  );
  expect(s.read().pending.map((p) => p.createdAt)).toEqual([5]);
  await add([mark("d".repeat(64), 4)]);
  expect(s.read().pending.map((p) => p.createdAt)).toEqual([5]);
  for (let i = 6; i < 1010; i++) await add([mark(undefined, i)]);
  expect(s.read().pending).toHaveLength(2); // a channel prefix cannot replace a whole-channel cut
  expect(s.read().pending.at(-1)?.createdAt).toBe(1009);
});
