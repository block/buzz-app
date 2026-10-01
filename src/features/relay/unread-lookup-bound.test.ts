import { verifiedSymbol } from "nostr-tools";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { ChannelQueries } from "./contracts";
import { eventVisibility } from "./event-access";
import type { ReadFilter, RelayEvent } from "./events";
import { createReadState } from "./read-state";
import { readJournal, type ReadJournal } from "./read-state-storage";
import { createUnread } from "./unread";

// Unread receives events the transport already verified, so this fixture
// marks thousands of events verified instead of signing them; signing them
// takes seconds. Session-level tests keep real signatures.
let next = 0;
function event(
  pubkey: string,
  kind: number,
  created_at: number,
  tags: string[][],
): RelayEvent {
  return {
    id: (next++).toString(16).padStart(64, "0"),
    pubkey,
    kind,
    created_at,
    content: "",
    tags: [["h", "c0"], ...tags],
    sig: "0".repeat(128),
    [verifiedSymbol]: true,
  };
}
const reply = (pubkey: string, time: number, parent: RelayEvent) =>
  event(pubkey, 9, time, [["e", parent.id, "", "reply"]]);

const owners: ReturnType<typeof createUnread>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

it("a lookup batch larger than the witness bound keeps every membership deletable", async () => {
  const viewer = "a".repeat(64),
    peer = "b".repeat(64);
  // Ten parents, each with 500 old replies of the viewer: one batch returns
  // 5,000 of the viewer's replies, more than the 4,096 witnesses unread keeps.
  const parents = Array.from({ length: 10 }, (_, i) =>
    event(peer, 9, 10 + i, []),
  );
  const mine = parents.map((parent) =>
    Array.from({ length: 500 }, (_, j) => reply(viewer, 20 + j, parent)),
  );
  const siblings = parents.map((parent, i) => reply(peer, 700 + i, parent));
  const store = [...parents, ...mine.flat()];
  const asked: string[] = [];
  const reader = {
    read: vi.fn(async (filters: readonly ReadFilter[]) =>
      filters.flatMap((filter) => {
        if (filter.authors && filter["#e"]?.length === 1)
          asked.push(filter["#e"][0] ?? "");
        if (!filter.ids && !filter.authors) return [];
        return store
          .filter(
            (item) =>
              (!filter.ids || filter.ids.includes(item.id)) &&
              (!filter.authors || filter.authors.includes(item.pubkey)) &&
              (!filter["#e"] ||
                item.tags.some(
                  ([name, value]) =>
                    name === "e" && filter["#e"]?.includes(value ?? ""),
                )),
          )
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, filter.limit);
      }),
    ),
  };
  let journal: ReadJournal | undefined;
  const reads = createReadState({
    viewer,
    reader,
    host: undefined,
    storage: {
      async update(change) {
        journal = readJournal(change(journal), viewer);
        return journal;
      },
      close() {},
    },
  });
  await reads.ready;
  const channels: ChannelQueries = {
    list: () => ({
      status: "ready" as const,
      channels: [{ id: "c0", name: "Channel", members: [viewer] }],
    }),
    subscribeList: () => () => {},
    window() {
      throw new Error("Unread must not inspect windows");
    },
    subscribeWindow() {
      throw new Error("Unread must not subscribe to windows");
    },
    ensureList() {},
    ensure() {},
    loadOlder() {},
  };
  const owner = createUnread({ reads, channels, reader, viewer });
  owners.push(owner);
  owner.accept(siblings);
  const attention = (i: number) => {
    const sibling = siblings[i];
    assert(sibling);
    return owner.capability.attention("c0", sibling.id);
  };
  // Ask for every parent in one turn, so they share one lookup batch.
  await vi.waitFor(() => {
    const states = parents.map((_, i) => attention(i));
    for (const state of states)
      expect(state).toMatchObject({ category: "thread", unread: true });
  });
  expect(
    reader.read.mock.calls.filter(([[filter]]) => filter?.ids),
  ).toHaveLength(1);
  // Witnessing every reply would evict the first-answered parent's replies
  // before the batch ends. Another client deletes all of them; like the
  // session, admit only deletions whose target unread can still show.
  const first = parents.findIndex((parent) => parent.id === asked[0]);
  const deleted = mine[first];
  assert(deleted);
  for (const item of deleted) store.splice(store.indexOf(item), 1);
  const visible = eventVisibility(
    () => true,
    (id) => owner.event(id),
  );
  owner.accept(
    deleted
      .map((item, i) => event(viewer, 5, 800 + i, [["e", item.id]]))
      .filter(visible),
  );
  await vi.waitFor(() => {
    expect(attention(first).pending).toBeUndefined();
    expect(attention(first)).toMatchObject({ unread: false });
  });
  expect(attention(first).category).toBeUndefined();
  for (const i of parents.keys())
    if (i !== first)
      expect(attention(i)).toMatchObject({ category: "thread", unread: true });
});
