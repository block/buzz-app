// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChannelMessage } from "../../features/relay/contracts";
import { key, capture, readList, revision, save, type Decision } from "./model";

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
