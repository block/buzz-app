// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChannelMessage } from "../../features/relay/contracts";
import { writeView } from "../../shared/view-state";
import {
  key,
  capture,
  readList,
  remove,
  revision,
  save,
  type Decision,
} from "./model";
import { installTestLocks } from "./test-locks";

const first = `https://one.test:${"a".repeat(64)}`;
const second = `https://one.test:${"b".repeat(64)}`;
const otherCommunity = `https://two.test:${"a".repeat(64)}`;
const message = {
  id: "e".repeat(64),
  channelId: "room",
  threadRootId: "f".repeat(64),
  content: "Should we ship this today?",
} as ChannelMessage;

beforeEach(() => {
  localStorage.clear();
  installTestLocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "locks");
});

const saveReady = (
  scope: string,
  expected: string | null | undefined,
  item: Decision,
) => save(scope, expected, item, () => true);
const removeReady = (
  scope: string,
  expected: string | null | undefined,
  item: Pick<Decision, "channelId" | "messageId">,
) => remove(scope, expected, item, () => true);

it("captures a source message and keeps records in their viewer and community", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_000);
  const item = capture(message, "  Ship today? ", " Laura ");
  expect(item).toMatchObject({
    messageId: message.id,
    channelId: "room",
    threadRootId: message.threadRootId,
    preview: "Should we ship this today?",
    question: "Ship today?",
    nextActor: "Laura",
    decision: "",
    stage: "decision",
    createdAt: 1_000,
  });
  expect(await saveReady(first, null, item)).toBe("saved");
  expect(readList(revision(first))).toEqual({
    status: "ready",
    records: [item],
  });
  expect(readList(revision(second))).toEqual({ status: "ready", records: [] });
  expect(readList(revision(otherCommunity))).toEqual({
    status: "ready",
    records: [],
  });
});

it("keeps a Unicode preview on whole code points", async () => {
  const item = capture(
    { ...message, content: "😀".repeat(250) },
    "Ship today?",
    "Morgan",
  );
  expect(item.preview).toBe(`${"😀".repeat(199)}…`);
  expect(await saveReady(first, null, item)).toBe("saved");
  expect(readList(revision(first))).toEqual({
    status: "ready",
    records: [item],
  });
});

it("reads a valid full list whose serialized form exceeds the old cutoff", () => {
  const base: Decision = {
    ...capture(message, "Question", "Actor"),
    channelId: "r".repeat(256),
    preview: "😀".repeat(200),
    question: "q".repeat(1000),
    nextActor: "a".repeat(200),
    decision: "d".repeat(2000),
    stage: "done",
  };
  const records = Array.from({ length: 500 }, (_, index) => ({
    ...base,
    messageId: index.toString(16).padStart(64, "0"),
  }));
  expect(JSON.stringify(records).length).toBeGreaterThan(512 * 1024);
  expect(writeView(first, key, records)).toBe(true);
  const list = readList(revision(first));
  expect(list.status).toBe("ready");
  if (list.status === "ready") expect(list.records).toHaveLength(500);
});

it("requires a decision before handoff, preserves the source, and replaces the same item", async () => {
  const item = capture(message, "Ship today?", "Laura");
  expect(await saveReady(first, null, item)).toBe("saved");
  const before = revision(first);
  expect(await saveReady(first, before, { ...item, stage: "handoff" })).toBe(
    "failed",
  );
  const decided: Decision = {
    ...item,
    stage: "handoff",
    decision: "Ship tomorrow",
  };
  expect(await saveReady(first, before, decided)).toBe("saved");
  expect(
    await saveReady(first, revision(first), {
      ...decided,
      stage: "done",
      nextActor: "Morgan",
    }),
  ).toBe("saved");
  const list = readList(revision(first));
  expect(list.status === "ready" && list.records).toEqual([
    { ...decided, stage: "done", nextActor: "Morgan" },
  ]);
});

it("rejects a stale write and leaves the newer list intact", async () => {
  const item = capture(message, "Ship today?", "Laura");
  expect(await saveReady(first, null, item)).toBe("saved");
  const old = revision(first);
  const updated = { ...item, question: "Ship tomorrow?" };
  expect(await saveReady(first, old, updated)).toBe("saved");
  expect(await saveReady(first, old, { ...item, question: "Stale edit" })).toBe(
    "changed",
  );
  expect(readList(revision(first))).toEqual({
    status: "ready",
    records: [updated],
  });
});

it("serializes competing window writes before checking the saved revision", async () => {
  let entered = () => {};
  let release = () => {};
  const acquired = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = navigator.locks.request(
    `buzz-decision-inbox:${first}`,
    { mode: "exclusive" },
    async () => {
      entered();
      await held;
    },
  );
  await acquired;
  const firstItem = capture(message, "First decision", "Morgan");
  const secondItem = {
    ...firstItem,
    messageId: "d".repeat(64),
    question: "Second decision",
  };
  const firstWrite = saveReady(first, null, firstItem);
  const secondWrite = saveReady(first, null, secondItem);
  expect(revision(first)).toBeNull();
  release();
  await blocker;
  expect(await firstWrite).toBe("saved");
  expect(await secondWrite).toBe("changed");
  expect(readList(revision(first))).toEqual({
    status: "ready",
    records: [firstItem],
  });
});

it("rechecks account and community after waiting for the write lock", async () => {
  let entered = () => {};
  let release = () => {};
  const acquired = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = navigator.locks.request(
    `buzz-decision-inbox:${first}`,
    { mode: "exclusive" },
    async () => {
      entered();
      await held;
    },
  );
  await acquired;
  let current = true;
  const pending = save(
    first,
    null,
    capture(message, "Question", "Morgan"),
    () => current,
  );
  current = false;
  release();
  await blocker;
  expect(await pending).toBe("scope-changed");
  expect(revision(first)).toBeNull();
});

it("does not write without a cross-window lock", async () => {
  Reflect.deleteProperty(navigator, "locks");
  expect(
    await saveReady(first, null, capture(message, "Question", "Morgan")),
  ).toBe("unavailable");
  expect(revision(first)).toBeNull();
});

it("holds malformed saved data for explicit recovery and reports failed storage", async () => {
  localStorage.setItem(`buzz-view.v1:${JSON.stringify([first, key])}`, "{bad");
  expect(readList(revision(first))).toEqual({ status: "damaged" });
  expect(
    await saveReady(
      first,
      revision(first),
      capture(message, "Question", "Laura"),
    ),
  ).toBe("damaged");
  expect(revision(first)).toBe("{bad");
  localStorage.clear();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  expect(
    await saveReady(first, null, capture(message, "Question", "Laura")),
  ).toBe("failed");
  expect(readList(revision(first))).toEqual({ status: "ready", records: [] });
});

it("removes only the selected saved item and rejects a stale removal", async () => {
  const item = capture(message, "Ship today?", "Morgan");
  const other = { ...item, messageId: "d".repeat(64), question: "Ship later?" };
  expect(await saveReady(first, null, item)).toBe("saved");
  expect(await saveReady(first, revision(first), other)).toBe("saved");
  const old = revision(first);
  expect(await removeReady(first, old, item)).toBe("saved");
  expect(await removeReady(first, old, other)).toBe("changed");
  expect(readList(revision(first))).toEqual({
    status: "ready",
    records: [other],
  });
  expect(readList(revision(second))).toEqual({ status: "ready", records: [] });
});

it("frees a full list for a new capture and reports failed device removal", async () => {
  const item = capture(message, "Ship today?", "Morgan");
  const records = Array.from({ length: 500 }, (_, index) => ({
    ...item,
    messageId: index.toString(16).padStart(64, "0"),
  }));
  const firstRecord = records[0];
  if (!firstRecord) throw new Error("Missing first record");
  expect(writeView(first, key, records)).toBe(true);
  const fullRevision = revision(first);
  expect(await saveReady(first, fullRevision, item)).toBe("full");
  expect(writeView(first, key, [firstRecord])).toBe(true);
  expect(await saveReady(first, fullRevision, item)).toBe("changed");
  expect(writeView(first, key, records)).toBe(true);
  expect(await removeReady(first, revision(first), firstRecord)).toBe("saved");
  expect(await saveReady(first, revision(first), item)).toBe("saved");
  const before = revision(first);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  expect(await removeReady(first, before, item)).toBe("failed");
  expect(revision(first)).toBe(before);
});
