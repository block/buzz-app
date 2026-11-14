import { expect, it } from "vitest";
import type { RegisteredPage } from "../features/pages/service";
import type { OpenTarget } from "../features/navigation/targets";
import { dockOwner, dockReturn } from "./dock-return";

const page = (key: string, extra: Partial<RegisteredPage> = {}) => {
  const [pluginId, id] = key.split("/");
  return { key, pluginId, id, ...extra } as RegisteredPage;
};
const pages = [
  page("buzz.channels/channels"),
  page("buzz.inbox/inbox", { conversationNavigation: true }),
  page("buzz.bestie/bestie"),
];
const scope = {
  viewer: "a".repeat(64),
  communityOrigin: "https://one.example",
};
const thread: OpenTarget = {
  version: 1,
  kind: "conversation",
  scope,
  channelId: "alpha",
  messageId: "b".repeat(64),
  threadRootId: "c".repeat(64),
  panel: "members",
  forward: "d".repeat(64),
  context: "channel",
};

it("files Activity and conversations under Messages", () => {
  expect(
    dockOwner(pages, {
      version: 1,
      kind: "page",
      pluginId: "buzz.inbox",
      pageId: "inbox",
      scope,
    }),
  ).toBe("buzz.channels/channels");
  expect(dockOwner(pages, thread)).toBe("buzz.channels/channels");
  expect(
    dockOwner(pages, { version: 1, kind: "settings", section: "appearance" }),
  ).toBeUndefined();
});

it("reopens a reply by its message alone, dropping its thread hint, Members, Forward and context", () => {
  const reply = {
    version: 1,
    kind: "conversation",
    scope,
    channelId: "alpha",
    messageId: "b".repeat(64),
  };
  // A hint, right or wrong, is dropped: the reader finds the reply's thread.
  expect(dockReturn(pages, "buzz.channels/channels", thread, scope)).toEqual(
    reply,
  );
  const { threadRootId: _root, ...hintless } = thread;
  expect(dockReturn(pages, "buzz.channels/channels", hintless, scope)).toEqual(
    reply,
  );
});

it("reopens a thread root with its thread", () => {
  const root: OpenTarget = { ...thread, messageId: "c".repeat(64) };
  expect(dockReturn(pages, "buzz.channels/channels", root, scope)).toEqual({
    version: 1,
    kind: "conversation",
    scope,
    channelId: "alpha",
    messageId: "c".repeat(64),
    threadRootId: "c".repeat(64),
  });
});

it("opens the app's own page for another scope, app or a removed page", () => {
  const other = { ...scope, communityOrigin: "https://two.example" };
  expect(
    dockReturn(pages, "buzz.channels/channels", thread, other),
  ).toBeUndefined();
  expect(dockReturn(pages, "buzz.channels/channels", thread, null)).toBe(
    undefined,
  );
  expect(dockReturn(pages, "buzz.bestie/bestie", thread, scope)).toBe(
    undefined,
  );
  const activity: OpenTarget = {
    version: 1,
    kind: "page",
    pluginId: "buzz.inbox",
    pageId: "inbox",
    scope,
  };
  expect(dockReturn(pages, "buzz.channels/channels", activity, scope)).toBe(
    activity,
  );
  expect(
    dockReturn(
      pages.filter((page) => page.key !== "buzz.inbox/inbox"),
      "buzz.channels/channels",
      activity,
      scope,
    ),
  ).toBeUndefined();
});
