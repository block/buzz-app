import { describe, expect, it, vi } from "vitest";
import type { EventData, ReadFilter } from "../relay/events";
import type { RelaySession } from "../relay/session";
import {
  cachedLinkedMessage,
  linkedMessageKey,
  prefetchLinkedMessages,
  prefetchLinkedMessagesIn,
  subscribeLinkedMessages,
  watchLinkedMessages,
} from "./linked-messages";

const id = (n: number) => n.toString(16).padStart(64, "a");
const link = (n: number) => `buzz://message?channel=general&id=${id(n)}`;
const author = "b".repeat(64);
const at = 1_700_000_000;

/** A relay holding messages 1 to 9 in #general, each linking message 20,
 * with message 1 edited and message 2 deleted by its author. */
function fakeSession() {
  const event = (
    eventId: string,
    kind: number,
    content: string,
    tags: string[][],
    created = at,
  ): EventData => ({
    id: eventId,
    kind,
    pubkey: author,
    created_at: created,
    content,
    tags: [...tags, ["h", "general"]],
  });
  const read = vi.fn(
    async (filters: readonly ReadFilter[], _options?: unknown) => {
      const [byId, changes] = filters;
      const events = (byId?.ids ?? []).map((messageId) =>
        event(messageId, 9, `body ${messageId.slice(-2)} ${link(20)}`, []),
      );
      const named = changes?.["#e"] ?? [];
      if (named.includes(id(1)))
        events.push(
          event("e".repeat(64), 40003, "edited body", [["e", id(1)]], at + 5),
        );
      if (named.includes(id(2)))
        events.push(event("d".repeat(64), 5, "", [["e", id(2)]], at + 5));
      return events;
    },
  );
  let live: ((batch: { events: readonly EventData[] }) => void) | undefined;
  const ensure = vi.fn(async () => {});
  const session = {
    read,
    relayAuthor: "f".repeat(64),
    profiles: { ensure, owner: undefined },
    subscribeLive: vi.fn((listener: typeof live) => {
      live = listener;
      return () => {};
    }),
  } as unknown as RelaySession;
  return {
    session,
    read,
    ensure,
    event,
    live: (events: EventData[]) => live?.({ events }),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const cached = (session: RelaySession, n: number) =>
  cachedLinkedMessage(session, linkedMessageKey("general", id(n)));

describe("prefetchLinkedMessages", () => {
  it("reads every link named in one turn together, folding edits and deletions", async () => {
    const { session, read, ensure } = fakeSession();
    const changed = vi.fn();
    subscribeLinkedMessages(session, changed);
    prefetchLinkedMessages(session, [link(1), link(2)], "foreground");
    prefetchLinkedMessages(session, [link(3), link(1)], "foreground");
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    const [filters, options] = read.mock.calls[0] ?? [];
    expect(filters?.[0]?.ids).toEqual([id(1), id(2), id(3)]);
    expect(filters?.[1]).toMatchObject({
      kinds: [5, 9005, 40003],
      "#e": [id(1), id(2), id(3)],
    });
    expect(options).toEqual({ priority: "foreground" });
    expect(cached(session, 1)?.content).toBe("edited body");
    expect(cached(session, 2)).toBeUndefined();
    expect(cached(session, 3)?.content).toContain("body a3");
    expect(changed).toHaveBeenCalled();
    expect(ensure).toHaveBeenCalledWith([author], "foreground");
    // Nothing already read, or found gone, is asked for again, and the
    // linked messages' own links are never followed.
    prefetchLinkedMessages(session, [link(1), link(2), link(3)], "foreground");
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    expect(cached(session, 20)).toBeUndefined();
  });

  it("reads cards about to be seen before speculative links", async () => {
    const { session, read } = fakeSession();
    prefetchLinkedMessagesIn(session, [`see ${link(4)}`], "background");
    prefetchLinkedMessages(session, [link(5)], "foreground");
    await settle();
    expect(
      read.mock.calls.map(([filters, options]) => [filters[0]?.ids, options]),
    ).toEqual([
      [[id(5)], { priority: "foreground" }],
      [[id(4)], { priority: "background" }],
    ]);
  });

  it("forgets a failed read so a later prefetch doesn't retry it", async () => {
    const { session, read } = fakeSession();
    read.mockRejectedValueOnce(new Error("offline"));
    prefetchLinkedMessages(session, [link(6)], "foreground");
    await settle();
    prefetchLinkedMessages(session, [link(6)], "foreground");
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    expect(cached(session, 6)).toBeUndefined();
  });
});

describe("watchLinkedMessages", () => {
  it("prefetches links in messages as they arrive, once per session", async () => {
    const { session, read, event, live } = fakeSession();
    watchLinkedMessages(session);
    watchLinkedMessages(session);
    expect(session.subscribeLive).toHaveBeenCalledTimes(1);
    live([
      event("1".repeat(64), 9, `look ${link(7)}`, []),
      event("2".repeat(64), 7, link(8), []),
    ]);
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0][0]?.ids).toEqual([id(7)]);
    expect(read.mock.calls[0]?.[1]).toEqual({ priority: "background" });
    expect(cached(session, 7)).toBeDefined();
  });
});
