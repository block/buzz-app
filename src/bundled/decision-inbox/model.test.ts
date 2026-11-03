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

const first = `https://one.test:${"a".repeat(64)}`;
const second = `https://one.test:${"b".repeat(64)}`;
const otherCommunity = `https://two.test:${"a".repeat(64)}`;
const message = {
  id: "e".repeat(64),
  channelId: "room",
  threadRootId: "f".repeat(64),
  content: "Should we ship this today?",
} as ChannelMessage;

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

it("captures a source message and keeps records in their viewer and community", () => {
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
  expect(save(first, null, item)).toBe("saved");
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

it("requires a decision before handoff, preserves the source, and replaces the same item", () => {
  const item = capture(message, "Ship today?", "Laura");
  expect(save(first, null, item)).toBe("saved");
  const before = revision(first);
  expect(save(first, before, { ...item, stage: "handoff" })).toBe("failed");
  const decided: Decision = {
    ...item,
    stage: "handoff",
    decision: "Ship tomorrow",
  };
  expect(save(first, before, decided)).toBe("saved");
  expect(
    save(first, revision(first), {
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

it("rejects a stale write and leaves the newer list intact", () => {
  const item = capture(message, "Ship today?", "Laura");
  expect(save(first, null, item)).toBe("saved");
  const old = revision(first);
  const updated = { ...item, question: "Ship tomorrow?" };
  expect(save(first, old, updated)).toBe("saved");
  expect(save(first, old, { ...item, question: "Stale edit" })).toBe("changed");
  expect(readList(revision(first))).toEqual({
    status: "ready",
    records: [updated],
  });
});

it("holds malformed saved data for explicit recovery and reports failed storage", () => {
  localStorage.setItem(`buzz-view.v1:${JSON.stringify([first, key])}`, "{bad");
  expect(readList(revision(first))).toEqual({ status: "damaged" });
  expect(
    save(first, revision(first), capture(message, "Question", "Laura")),
  ).toBe("damaged");
  expect(revision(first)).toBe("{bad");
  localStorage.clear();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  expect(save(first, null, capture(message, "Question", "Laura"))).toBe(
    "failed",
  );
  expect(readList(revision(first))).toEqual({ status: "ready", records: [] });
});

it("removes only the selected saved item and rejects a stale removal", () => {
  const item = capture(message, "Ship today?", "Morgan");
  const other = { ...item, messageId: "d".repeat(64), question: "Ship later?" };
  expect(save(first, null, item)).toBe("saved");
  expect(save(first, revision(first), other)).toBe("saved");
  const old = revision(first);
  expect(remove(first, old, item)).toBe("saved");
  expect(remove(first, old, other)).toBe("changed");
  expect(readList(revision(first))).toEqual({
    status: "ready",
    records: [other],
  });
  expect(readList(revision(second))).toEqual({ status: "ready", records: [] });
});

it("frees a full list for a new capture and reports failed device removal", () => {
  const item = capture(message, "Ship today?", "Morgan");
  const records = Array.from({ length: 500 }, (_, index) => ({
    ...item,
    messageId: index.toString(16).padStart(64, "0"),
  }));
  const firstRecord = records[0];
  if (!firstRecord) throw new Error("Missing first record");
  expect(writeView(first, key, records)).toBe(true);
  expect(save(first, revision(first), item)).toBe("full");
  expect(remove(first, revision(first), firstRecord)).toBe("saved");
  expect(save(first, revision(first), item)).toBe("saved");
  const before = revision(first);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  expect(remove(first, before, item)).toBe("failed");
  expect(revision(first)).toBe(before);
});
