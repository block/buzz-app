// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useReading } from "./use-reading";
import { createRelaySession } from "../relay/session";
import type { RelayEvent } from "../relay/events";
import { foldMessages } from "../relay/fold";
import type { ReadStateSigning } from "../relay/read-state-host";
import { readJournal, type ReadJournal } from "../relay/read-state-storage";
import { keypair, message, metadata, roster, signed } from "../relay/testing";
import {
  decodeReadState,
  signReadState,
  // @ts-expect-error Test the production Node codec with disposable identities.
} from "../../../browser-host/read-state.mjs";

const stops: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(
  [45001, 45003].flatMap((kind) =>
    [0, 9, 45001].flatMap((rootKind) =>
      ["forum last", "forum first", "stale forum bottom"].map((position) => ({
        kind,
        rootKind,
        position,
      })),
    ),
  ),
)(
  "reads chat alongside kind $kind, root kind=$rootKind, $position",
  async ({ kind, rootKind, position }) => {
    const thread = rootKind !== 0;
    const viewer = keypair(),
      relay = keypair(),
      author = keypair();
    let journal: ReadJournal | undefined;
    let incoming: (events: readonly RelayEvent[]) => void = () => {};
    const owner = createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        query: async () => [],
        media: () => undefined,
        readState: {
          decode: async (events: readonly RelayEvent[]) =>
            decodeReadState(events, viewer.secret),
          sign: async (intent: ReadStateSigning) =>
            signReadState(intent, viewer.secret),
          publish: async () => {},
        },
        subscribe(callbacks) {
          incoming = callbacks.receive;
          return { update() {}, retry() {}, dispose() {} };
        },
      },
      {
        readStateFloor: () => 0,
        readStateStorage: {
          capture: async () => journal && readJournal(journal, viewer.pubkey),
          async update(change) {
            journal = readJournal(change(journal), viewer.pubkey);
            return journal;
          },
          close() {},
        },
        readPublisherLock: async (_signal, work) => work(),
      },
    );
    stops.push(owner.dispose);
    const root = signed(viewer, {
      kind: rootKind || 9,
      content: "root",
      created_at: 10,
      tags: [["h", "room"]],
    });
    const tags = thread ? [["e", root.id, "", "reply"]] : [];
    const chat = message(author, "room", "unread chat", 12, [
      ...tags,
      ["p", viewer.pubkey],
    ]);
    const forum = signed(author, {
      kind,
      content: "forum content",
      created_at: position === "forum first" ? 11 : 13,
      tags: [["h", "room"], ...tags],
    });
    incoming([
      roster(relay, "room", [viewer.pubkey], 1),
      metadata(relay, "room", "Room", 1),
      root,
      chat,
      forum,
    ]);
    const unread = owner.session.unread;
    await unread.ensure();
    expect(unread.attention("room", chat.id).unread).toBe(true);

    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const list = document.createElement("div");
    list.tabIndex = 0;
    document.body.append(list);
    list.focus();
    vi.spyOn(list, "getClientRects").mockReturnValue([
      new DOMRect(0, 0, 500, 500),
    ] as unknown as DOMRectList);
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 500, 500),
    );
    Object.defineProperties(list, {
      clientHeight: { value: 500 },
      scrollHeight: { value: position === "forum first" ? 1000 : 500 },
    });
    const rows = foldMessages("room", relay.pubkey, [chat, forum], {
      includeReplies: true,
    });
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === chat.id)?.threadRootId).toBe(
      thread ? root.id : undefined,
    );
    rows.forEach((row, index) => {
      const element = document.createElement("div");
      element.dataset.messageId = row.id;
      // MessageRow's matching DOM contract is covered in its mounted action matrix.
      if (row.forum) element.dataset.forumRow = "";
      list.append(element);
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
        new DOMRect(0, 100 + index * 100, 400, 100),
      );
    });
    renderHook(useReading, {
      initialProps: {
        session: owner.session,
        channelId: "room",
        rootId: thread ? root.id : undefined,
        latestMessageId:
          rootKind === 45001
            ? undefined
            : position === "stale forum bottom"
              ? forum.id
              : chat.id,
        scroller: { current: list },
        settled: { current: true },
      },
    });
    await vi.advanceTimersByTimeAsync(299);
    expect(unread.attention("room", chat.id).unread).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() =>
      expect(unread.attention("room", chat.id).unread).toBe(false),
    );
    if (position === "forum last" && rootKind !== 45001)
      expect(
        journal?.state.frontiers[thread ? `thread:${root.id}` : "room"],
      ).toBe(chat.created_at);
    // The change must not make forum IDs admissible unread evidence.
    const lease = unread.reading("room", thread ? root.id : undefined);
    try {
      await expect(lease.observe([forum.id])).rejects.toThrow(
        "Verified readable message evidence unavailable",
      );
    } finally {
      lease.dispose();
    }
  },
);
