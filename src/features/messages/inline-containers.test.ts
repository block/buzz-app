import { describe, expect, it, vi } from "vitest";
import { createNavigationController } from "../navigation/controller";
import { createMemoryHistory } from "../navigation/history";
import type { OpenTarget } from "../navigation/targets";
import {
  type ComposerHandle,
  channelComposer,
  createComposerHandle,
  threadComposer,
} from "./composer-overlay";
import {
  closed,
  composerGone,
  createOpener,
  createStore,
  entryId,
  type InlineEntry,
  type InlineRequest,
  left,
  movedToTab,
  opened,
  type Placed,
  placement,
  closedOnSend,
} from "./inline-containers";

const channel = createComposerHandle(channelComposer("C"));
const replyBox = (rootId: string) =>
  createComposerHandle(threadComposer("C", rootId));
const thread = (rootId: string): InlineEntry => ({
  target: { kind: "thread", channelId: "C", rootId, messageId: rootId },
  composer: channel,
  trigger: null,
  placement: "inline",
});
const details = (messageId: string, composer: ComposerHandle): InlineEntry => ({
  target: { kind: "details", messageId },
  composer,
  trigger: null,
  placement: "inline",
});

let key = 0;
const open = (list: Placed[], ...items: InlineEntry[]) =>
  items.reduce((next, item) => opened(next, item, ++key), list);
const shown = (list: readonly Placed[]) =>
  list.filter((item) => item.open).map((item) => entryId(item.target));

it("opens inline over a shown composer, else in its tab, else a dialog", () => {
  const request: InlineRequest = {
    target: { kind: "details", messageId: "M" },
    composer: channel,
    trigger: null,
  };
  const shownComposer = () => true;
  const away = () => false;
  expect(placement(request, shownComposer)).toBe("inline");
  expect(placement(request, away)).toBe("dialog");
  const tabbed = { ...request, openAsTab: () => {} };
  expect(placement(tabbed, away)).toBe("tab");
  // Something with a tab shows its tab, even with a composer to open over.
  expect(placement({ ...tabbed, hasTab: true }, shownComposer)).toBe("tab");
});

it("replaces what is over the same composer and keeps the rest", () => {
  const box = replyBox("R");
  const list = open([], thread("R"), details("M", box));
  // Another thread replaces the first over the channel composer, and takes
  // the details open on it along.
  expect(shown(open(list, thread("S")))).toEqual(["thread:C:S"]);
  // New details over the thread replace only the details there.
  expect(shown(open(list, details("N", box)))).toEqual([
    "thread:C:R",
    "details:N",
  ]);
  // Opening the same thing again replaces it, wherever it was.
  expect(shown(open(list, details("M", channel)))).toEqual(["details:M"]);
});

it("closes everything open on an entry with it", () => {
  const list = open([], thread("R"), details("M", replyBox("R")));
  expect(shown(closed(list, "thread:C:R"))).toEqual([]);
  // Closing the top leaves the thread.
  expect(shown(closed(list, "details:M"))).toEqual(["thread:C:R"]);
});

it("closes the details over a composer that sends, only there", () => {
  const box = replyBox("R");
  const other = createComposerHandle(channelComposer("D"));
  const list = open([], thread("R"), details("M", box), details("N", other));
  expect([...closedOnSend(list, box)]).toEqual(["details:M"]);
  // A thread is not closed by a send from the composer under it.
  expect([...closedOnSend(list, channel)]).toEqual([]);
});

it("closes what is over a composer that is gone, as a closed tab's", () => {
  const tab = replyBox("R");
  const list = open([], details("M", tab), details("N", channel));
  expect(shown(composerGone(list, tab))).toEqual(["details:N"]);
  // Another scope with the same name keeps its own.
  expect(shown(composerGone(list, replyBox("R")))).toEqual(shown(list));
});

it("moves a thread to its tab and closes what was open on it", () => {
  const list = open([], thread("R"), details("M", replyBox("R")));
  const moved = movedToTab(list, "thread:C:R");
  expect(shown(moved)).toEqual([]);
  // The thread leaves at once; its tab shows it.
  expect(moved.some((item) => entryId(item.target) === "thread:C:R")).toBe(
    false,
  );
});

it("closes a channel's entries when the workspace leaves it", () => {
  const other = createComposerHandle(channelComposer("D"));
  const list = open([], thread("R"), details("N", other));
  expect(shown(left(list, "D"))).toEqual(["details:N"]);
  expect(shown(left(list, undefined))).toEqual([]);
  // Staying in the channel changes nothing.
  const same = open([], thread("R"));
  expect(left(same, "C")).toBe(same);
});

describe("history", () => {
  const scope = {
    viewer: "a".repeat(64),
    communityOrigin: "https://example.org",
  };
  const conversation = {
    version: 1,
    kind: "conversation",
    scope,
    channelId: "C",
  } as const;
  // Addresses as the channel workspace gives them: one per entry.
  const address = (entry: InlineEntry | undefined): OpenTarget =>
    !entry
      ? conversation
      : entry.target.kind === "panel"
        ? { ...conversation, detail: { target: entry.target.title } }
        : entry.target.kind === "thread"
          ? {
              ...conversation,
              messageId: entry.target.rootId,
              threadRootId: entry.target.rootId,
            }
          : {
              ...conversation,
              reader: {
                kind: entry.target.kind,
                messageId: entry.target.messageId,
              },
            };
  function setup() {
    const history = createMemoryHistory(conversation);
    const { navigation } = createNavigationController(history);
    const opener = createOpener(createStore(), { current: undefined });
    opener.attachHistory({ navigator: navigation, address });
    const open = () =>
      opener.store
        .get()
        .filter((item) => item.open)
        .map((item) =>
          item.target.kind === "panel"
            ? item.target.title
            : entryId(item.target),
        );
    return { navigation, opener, open };
  }
  const id = (n: number) => n.toString(16).padStart(64, "0");

  it("visits each opening; Back closes it, Forward reopens it, and ✕ retires it", () => {
    const { navigation, opener, open } = setup();
    opener.open({
      target: { kind: "details", messageId: id(1) },
      composer: channel,
      trigger: null,
    });
    const visit = navigation.snapshot().entry;
    expect(visit.target).toMatchObject({ reader: { kind: "details" } });
    expect(opener.presents(visit.id)).toBe(true);
    expect(open()).toEqual([`details:${id(1)}`]);
    navigation.back();
    expect(open()).toEqual([]);
    navigation.forward();
    expect(open()).toEqual([`details:${id(1)}`]);
    opener.dismiss(`details:${id(1)}`);
    expect(open()).toEqual([]);
    expect(navigation.snapshot().canGoForward).toBe(false);
    expect(navigation.snapshot().entry.target).toEqual(conversation);
  });

  it("opening what the visit already names adds no visit", () => {
    const { navigation, opener } = setup();
    const request: InlineRequest = {
      target: { kind: "details", messageId: id(1) },
      composer: channel,
      trigger: null,
    };
    opener.open(request);
    const visit = navigation.snapshot().entry.id;
    opener.open(request);
    expect(navigation.snapshot().entry.id).toBe(visit);
  });

  it("makes each page a panel moves to a visit, and ✕ retires them all", () => {
    const { navigation, opener, open } = setup();
    const page = (title: string) =>
      ({ kind: "panel", channelId: "C", title, opening: undefined }) as const;
    opener.open({ target: page("first"), composer: channel, trigger: null });
    opener.navigate("panel:C:", page("second"));
    expect(open()).toEqual(["second"]);
    navigation.back();
    expect(open()).toEqual(["first"]);
    navigation.back();
    expect(open()).toEqual([]);
    navigation.forward();
    navigation.forward();
    expect(open()).toEqual(["second"]);
    opener.dismiss("panel:C:");
    expect(navigation.snapshot().canGoForward).toBe(false);
    navigation.back();
    expect(open()).toEqual([]);
  });

  it("✕ forgets an opening in every visit, so Forward to a later one shows nothing of it", () => {
    const { navigation, opener, open } = setup();
    opener.open({
      target: {
        kind: "thread",
        channelId: "C",
        rootId: id(1),
        messageId: id(1),
      },
      composer: channel,
      trigger: null,
    });
    opener.open({
      target: { kind: "details", messageId: id(2) },
      composer: replyBox(id(1)),
      trigger: null,
    });
    navigation.back();
    expect(open()).toEqual([threadComposer("C", id(1))]);
    opener.dismiss(threadComposer("C", id(1)));
    navigation.forward();
    expect(open()).toEqual([]);
  });

  it("a thread moved to its tab leaves what was open on it to open the usual way", () => {
    const { navigation, opener } = setup();
    opener.open({
      target: {
        kind: "thread",
        channelId: "C",
        rootId: id(1),
        messageId: id(1),
      },
      composer: channel,
      trigger: null,
    });
    opener.open({
      target: { kind: "details", messageId: id(2) },
      composer: replyBox(id(1)),
      trigger: null,
    });
    navigation.back();
    opener.moveToTab(threadComposer("C", id(1)));
    navigation.forward();
    // Details have no tab: with the reply box gone, they open in a dialog.
    expect(
      opener.store
        .get()
        .filter((item) => item.open)
        .map((item) => [entryId(item.target), item.placement]),
    ).toEqual([[`details:${id(2)}`, "dialog"]]);
  });
  // Details over a thread tab's reply box, as that tab's sheet: Back to their
  // visit, after a visit that showed nothing, brings them back to wait for it.
  function overTab(channelId: string) {
    const setup_ = setup();
    const { navigation, opener } = setup_;
    const box = createComposerHandle(threadComposer(channelId, id(9)));
    void navigation.open({
      ...conversation,
      reader: { kind: "details", messageId: id(1) },
    });
    opener.store.set(() =>
      opened([], { ...details(id(1), box) }, 1, [
        navigation.snapshot().entry.id,
      ]),
    );
    void navigation.open({ ...conversation, messageId: id(3) });
    expect(setup_.open()).toEqual([]);
    navigation.back();
    const placed = () =>
      opener.store
        .get()
        .filter((item) => item.open)
        .map((item) => [item.placement, !!item.waiting]);
    return { ...setup_, placed };
  }

  it("details over a thread tab wait for it while a tab holds its reply box", () => {
    const { opener, placed } = overTab("D");
    expect(placed()).toEqual([["inline", true]]);
    opener.settle("C", (name) => name === threadComposer("D", id(9)));
    expect(placed()).toEqual([["inline", true]]);
  });

  it("details over a thread tab give up once no tab holds its reply box", () => {
    // Another channel's: they close, as leaving that channel does.
    const other = overTab("D");
    other.opener.settle("C", () => false);
    expect(other.placed()).toEqual([]);
    // This channel's: they open as they would without it, in a dialog.
    const own = overTab("C");
    own.opener.settle("C", () => false);
    expect(own.placed()).toEqual([["dialog", false]]);
  });

  it("details over a thread tab give up when its reply box does not come back soon", () => {
    vi.useFakeTimers();
    try {
      const { opener, placed } = overTab("C");
      opener.settle("C", () => true);
      vi.advanceTimersByTime(4999);
      expect(placed()).toEqual([["inline", true]]);
      vi.advanceTimersByTime(1);
      expect(placed()).toEqual([["dialog", false]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("details over a thread tab brought back again wait their full time", () => {
    vi.useFakeTimers();
    try {
      const { navigation, opener, placed } = overTab("C");
      opener.settle("C", () => true);
      vi.advanceTimersByTime(3000);
      navigation.forward();
      expect(placed()).toEqual([]);
      vi.advanceTimersByTime(1000);
      navigation.back();
      expect(placed()).toEqual([["inline", true]]);
      // The first wait's time is up; this one has most of its own left.
      vi.advanceTimersByTime(4999);
      expect(placed()).toEqual([["inline", true]]);
      vi.advanceTimersByTime(1);
      expect(placed()).toEqual([["dialog", false]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("details over a thread tab give up to a dialog over the row mounted now", () => {
    vi.useFakeTimers();
    try {
      const { opener, placed } = overTab("C");
      opener.settle("C", () => true);
      // The tab's row is back without a reply box, as over an archived channel.
      const again = createComposerHandle(threadComposer("C", id(9)));
      opener.outlet(again);
      vi.advanceTimersByTime(5000);
      expect(placed()).toEqual([["dialog", false]]);
      expect(opener.store.get().find((item) => item.open)?.composer).toBe(
        again,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
