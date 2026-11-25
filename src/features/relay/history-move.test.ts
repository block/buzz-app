import { afterEach, expect, it, vi } from "vitest";
import type { ReadFilter, RelayEvent } from "./events";
import type { LiveCallbacks } from "./live";
import { createRelaySession } from "./session";
import { readJournal, type ReadJournal } from "./read-state-storage";
import { cutTime, historyMoves, movedIds } from "./history-move";
import {
  bounds,
  flush,
  keypair,
  message,
  metadata,
  roster,
  signed,
} from "./testing";

const source = "11111111-1111-4111-8111-111111111111";
const destination = "22222222-2222-4222-8222-222222222222";
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

function setup() {
  const viewer = keypair(),
    relay = keypair(),
    peer = keypair();
  let journal: ReadJournal | undefined;
  let live: LiveCallbacks | undefined;
  // What the relay holds of the source, newest first as a head read returns it.
  const held: RelayEvent[] = [];
  // The relay's notices, as a notice read returns them.
  const notices: RelayEvent[] = [];
  const query = vi.fn(async (filters: readonly ReadFilter[]) => {
    const filter = filters[0];
    if (filter?.top_level)
      return [
        ...held,
        bounds(relay, source, "head", { has_more: false, next_cursor: null }),
      ];
    if (filter?.kinds?.includes(9)) return held;
    if (filter?.kinds?.includes(40099)) return notices;
    return [];
  });
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      query,
      media: () => undefined,
      readState: { decode: async () => [] },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      readStateFloor: () => 0,
      readStateStorage: {
        capture: async () => structuredClone(journal),
        async update(change) {
          journal = readJournal(change(journal), viewer.pubkey);
          return journal;
        },
        close() {},
      },
    },
  );
  owners.push(owner);
  live?.receive([
    roster(relay, source, [viewer.pubkey, peer.pubkey], 10),
    metadata(relay, source, "Plans", 10),
  ]);
  const notice = (cut: string, at = 100) =>
    signed(relay, {
      kind: 40099,
      created_at: at,
      content: JSON.stringify({
        type: "history_moved",
        actor: peer.pubkey,
        from: source,
        to: destination,
        cut,
        count: 2,
        added: [],
      }),
      tags: [["h", source]],
    });
  return {
    ...owner,
    viewer,
    relay,
    peer,
    held,
    notices,
    query,
    notice,
    receive: (events: readonly RelayEvent[]) => live?.receive(events),
    rows: () =>
      owner.session.channels
        .window(source)
        .rows.filter((row) => !row.membership)
        .map((row) => row.id),
    unread: () =>
      owner.session.unread.snapshot({ kind: "channel", channelId: source }),
  };
}

it("drops the moved messages with their reactions and edits, and keeps what came before and after", async () => {
  const h = setup();
  const before = message(h.peer, source, "Before", 11);
  const cut = message(h.peer, source, "Cut", 12);
  const after = message(h.peer, source, "After", 13);
  const reaction = signed(h.peer, {
    kind: 7,
    content: "+",
    created_at: 14,
    tags: [
      ["h", source],
      ["e", after.id],
    ],
  });
  const edit = signed(h.peer, {
    kind: 40003,
    content: "After, edited",
    created_at: 15,
    tags: [
      ["h", source],
      ["e", after.id],
    ],
  });
  h.held.push(before, cut, after, reaction, edit);
  h.session.channels.ensure(source);
  await flush();
  await flush();
  await h.session.unread.ensure();
  expect(h.rows()).toEqual([before.id, cut.id, after.id]);
  expect(h.unread().observedCount).toBe(3);
  expect(h.unread().latestMessage?.id).toBe(after.id);
  // The relay moves the history, then says so on the live stream.
  h.held.splice(1);
  h.receive([h.notice(cut.id)]);
  await flush();
  expect(h.rows()).toEqual([before.id]);
  // The unread position follows what stayed.
  expect(h.unread()).toMatchObject({
    observedCount: 1,
    latestMessage: { id: before.id },
  });
  // A message sent after the move is not mistaken for a moved one.
  const next = message(h.peer, source, "Next", 101);
  h.receive([next]);
  await flush();
  expect(h.rows()).toEqual([before.id, next.id]);
  expect(h.unread().observedCount).toBe(2);
});

it("applies a move once, however often its notice is seen", async () => {
  const h = setup();
  const cut = message(h.peer, source, "Cut", 12);
  h.held.push(cut);
  h.session.channels.ensure(source);
  await flush();
  await flush();
  const notice = h.notice(cut.id, 100);
  h.held.splice(0);
  h.receive([notice]);
  await flush();
  expect(h.rows()).toEqual([]);
  // The same second as the notice: a later message is kept, as it would be had
  // the notice not repeated.
  const same = message(h.peer, source, "Same second", 100);
  h.receive([same]);
  h.receive([notice]);
  await flush();
  expect(h.rows()).toEqual([same.id]);
});

it("without the cut cached, live traffic drops every earlier row and rereads the head", async () => {
  const h = setup();
  const old = message(h.peer, source, "Old", 11);
  h.held.push(old);
  h.session.channels.ensure(source);
  await flush();
  await flush();
  expect(h.rows()).toEqual([old.id]);
  const reads = h.query.mock.calls.length;
  h.held.splice(0);
  h.receive([h.notice("f".repeat(64))]);
  await flush();
  await flush();
  expect(h.rows()).toEqual([]);
  // The relay says where the history now ends.
  expect(h.query.mock.calls.length).toBeGreaterThan(reads);
});

it("reads the relay's notices in the source only, and what moved from the cut", () => {
  const relay = keypair(),
    peer = keypair();
  const body = {
    type: "history_moved",
    actor: peer.pubkey,
    from: source,
    to: destination,
    cut: "c".repeat(64),
    count: 1,
    added: [],
  };
  const inSource = signed(relay, {
    kind: 40099,
    created_at: 50,
    content: JSON.stringify(body),
    tags: [["h", source]],
  });
  const inDestination = signed(relay, {
    kind: 40099,
    created_at: 50,
    content: JSON.stringify(body),
    tags: [["h", destination]],
  });
  const spoofed = signed(peer, {
    kind: 40099,
    created_at: 50,
    content: JSON.stringify(body),
    tags: [["h", source]],
  });
  expect(
    historyMoves([inSource, inDestination, spoofed], relay.pubkey),
  ).toEqual([
    {
      id: inSource.id,
      channelId: source,
      cut: body.cut,
      at: 50,
      to: destination,
    },
  ]);
  const [move] = historyMoves([inSource], relay.pubkey);
  if (!move) throw new Error("no move");
  const old = message(peer, source, "Old", 10);
  const moved = message(peer, source, "Moved", 20);
  const later = message(peer, source, "Later", 60);
  const elsewhere = message(peer, destination, "Elsewhere", 30);
  const pool = [old, moved, later, elsewhere, inSource];
  expect(cutTime(move, pool)).toBeUndefined();
  // A cache read since the move that never held the cut keeps everything.
  expect(movedIds(pool, move, undefined, false).size).toBe(0);
  // A cache that predates the move drops every row up to the notice.
  expect([...movedIds(pool, move, undefined, true)].sort()).toEqual(
    [old.id, moved.id].sort(),
  );
  expect([...movedIds(pool, move, 20, true)]).toEqual([moved.id]);
});

it("drops a stale cache when a notice read names a cut it holds, and keeps a fresh read as it is", async () => {
  const h = setup();
  const before = message(h.peer, source, "Before", 11);
  const cut = message(h.peer, source, "Cut", 12);
  h.held.push(before, cut);
  h.notices.push(h.notice(cut.id));
  h.session.channels.ensure(source);
  await flush();
  await flush();
  await flush();
  // The head the cache served still held the cut; the notice read says it moved.
  expect(h.rows()).toEqual([before.id]);
  // A fresh read that never held the cut keeps every row it returned.
  const fresh = setup();
  const kept = message(fresh.peer, source, "Kept", 11);
  fresh.held.push(kept);
  fresh.notices.push(fresh.notice("e".repeat(64)));
  fresh.session.channels.ensure(source);
  await flush();
  await flush();
  await flush();
  expect(fresh.rows()).toEqual([kept.id]);
});
