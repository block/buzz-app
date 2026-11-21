import { describe, expect, it, vi } from "vitest";
import type { EventData, ReadFilter } from "../relay/events";
import type { Outbox } from "../relay/outbox";
import { createMarketplace, readReactions } from "./marketplace";
import type { SharedAgent } from "./shared-agents";

type Session = Parameters<typeof createMarketplace>[0];

const owner = "c1".repeat(32);
const viewer = "ef".repeat(32);
const agent = {
  id: `${owner}:helper`,
  owner,
  d: "helper",
  event: "ab".repeat(32),
  createdAt: 1,
  name: "Helper",
  instructions: "",
  model: "",
} as SharedAgent;
const at = `30175:${owner}:helper`;

let next = 0;
const reaction = (
  pubkey: string,
  content: string,
  created_at = 100,
): EventData => ({
  id: (next++).toString(16).padStart(64, "0"),
  pubkey,
  created_at,
  kind: 7,
  content,
  tags: [
    ["e", agent.event],
    ["a", at],
    ["k", "30175"],
  ],
});

/** Records sends; `delivery` decides each one's outcome. */
function outbox(delivery: (count: number) => string = () => "accepted") {
  const sent: { id: string; kind: number; tags: string[][] }[] = [];
  let items: { event: { id: string }; delivery: string; error?: string }[] = [];
  const listeners = new Set<() => void>();
  const fake = {
    sent,
    supports: () => true,
    ready: async () => {},
    snapshot: () => items,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: (input: { kind: number; tags: string[][] }) => {
      const id = `sent-${sent.length}`;
      sent.push({ id, ...input });
      const outcome = delivery(sent.length);
      items = [...items, { event: { id }, delivery: "sending" }];
      queueMicrotask(() => {
        items = items.map((item) =>
          item.event.id === id
            ? { ...item, delivery: outcome, error: "Refused by relay" }
            : item,
        );
        for (const listener of listeners) listener();
      });
      return id;
    },
    dismiss: async () => {},
  };
  return fake as typeof fake & Outbox;
}

describe("readReactions", () => {
  it("pages through everyone's reactions up to the cap, then reads your own", async () => {
    // Full pages of junk forever: the cap ends the read, not the relay.
    const readRemote = vi.fn(async (filters: readonly ReadFilter[]) => {
      const [filter] = filters;
      if (filter?.authors) return [reaction(viewer, "⭐", 1)];
      return Array.from({ length: filter?.limit ?? 0 }, () =>
        reaction("aa".repeat(32), "👍"),
      );
    });
    const reactions = await readReactions(
      { readRemote } as unknown as Session,
      [agent],
      new AbortController().signal,
      viewer,
    );
    const everyone = readRemote.mock.calls.filter(
      ([filters]) => !filters[0]?.authors,
    );
    expect(everyone).toHaveLength(20);
    // Each later page continues from the last one's oldest event.
    expect(everyone[1]?.[0][0]).toMatchObject({
      until: 100,
      before_id: expect.any(String),
    });
    expect(readRemote).toHaveBeenLastCalledWith(
      [{ kinds: [7], "#a": [at], authors: [viewer], limit: 500 }],
      expect.anything(),
    );
    // Buried past the cap, your star is still found.
    expect(reactions.stars.get(at)?.get(viewer)).toHaveLength(1);
  });
});

describe("createMarketplace", () => {
  const ready = async (
    reactions: EventData[],
    writes = outbox(),
    as: string | undefined = viewer,
  ) => {
    const marketplace = createMarketplace(
      {
        readRemote: async () => reactions,
        outbox: writes,
      } as unknown as Session,
      as,
    );
    await marketplace.load([agent], new AbortController().signal);
    return { marketplace, writes };
  };

  it("unstars every star reaction you have on an agent", async () => {
    const stars = [reaction(viewer, "⭐"), reaction(viewer, "⭐")];
    const { marketplace, writes } = await ready(stars);
    await marketplace.toggleStar(agent);
    expect(writes.sent.map((event) => event.tags)).toEqual(
      stars.map((star) => [
        ["e", star.id],
        ["k", "7"],
      ]),
    );
    expect(marketplace.snapshot().stars.get(at)?.has(viewer)).toBe(false);
  });

  it("keeps the stars a partly refused unstar left standing", async () => {
    const stars = [reaction(viewer, "⭐"), reaction(viewer, "⭐")];
    const { marketplace } = await ready(
      stars,
      outbox((count) => (count === 2 ? "failed" : "accepted")),
    );
    await marketplace.toggleStar(agent);
    const state = marketplace.snapshot();
    expect(state.stars.get(at)?.get(viewer)).toEqual([stars[1]?.id]);
    expect(state.failures.get(at)).toBe("Couldn’t unstar: Refused by relay");
  });

  it("publishes no import record for the owner's own agent", async () => {
    const { marketplace, writes } = await ready([], outbox(), owner);
    expect(marketplace.recordable(agent)).toBe(false);
    await marketplace.recordImport(agent);
    expect(writes.sent).toEqual([]);
    const other = await ready([]);
    expect(other.marketplace.recordable(agent)).toBe(true);
  });
});
