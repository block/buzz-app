import { expect, it } from "vitest";
import { arrangeChatList } from "./chat-list-arrangement";

const chats = [
  { id: "a", title: "A", lastMessageAt: 300, pinned: false, unread: false },
  { id: "b", title: "B", lastMessageAt: 200, pinned: true, unread: false },
  { id: "c", title: "C", pinned: false, unread: true },
];

it("keeps the host's order without an arrangement", () => {
  expect(arrangeChatList(undefined, chats)).toEqual({ chats });
});

it("reorders by the plugin's order, appending chats it leaves out", () => {
  const arranged = arrangeChatList(
    () => ({ order: ["c", "unknown", "a", "c"] }),
    chats,
  );
  expect(arranged.chats.map((chat) => chat.id)).toEqual(["c", "a", "b"]);
});

it("never folds a pinned or unknown chat", () => {
  const arranged = arrangeChatList(
    () => ({ folded: { label: " Inactive ", ids: ["a", "b", "zzz"] } }),
    chats,
  );
  expect(arranged.folded?.label).toBe("Inactive");
  expect([...(arranged.folded?.ids ?? [])]).toEqual(["a"]);
  expect(arranged.chats).toHaveLength(3);
});

it.each([
  [
    "throws",
    () => {
      throw new Error("boom");
    },
  ],
  ["returns nothing", () => undefined as never],
  ["labels nothing", () => ({ folded: { label: "  ", ids: ["a"] } })],
  [
    "labels too long",
    () => ({ folded: { label: "x".repeat(41), ids: ["a"] } }),
  ],
])("ignores a fold when the arrangement %s", (_, arrange) => {
  const arranged = arrangeChatList(arrange, chats);
  expect(arranged.folded).toBeUndefined();
  expect(arranged.chats.map((chat) => chat.id)).toEqual(["a", "b", "c"]);
});

it("hands the plugin copies it cannot change", () => {
  arrangeChatList((entries) => {
    expect(Object.isFrozen(entries[0])).toBe(true);
    return {};
  }, chats);
});
