import { assert, describe, expect, it } from "vitest";
import { foldMessages } from "./fold";
import { foldProfiles } from "./profiles";
import { DiscoveryState } from "./discovery";
import {
  keypair,
  message,
  metadata,
  profile,
  roster,
  signed,
  summary,
} from "./testing";

const relay = keypair(),
  alice = keypair(),
  bob = keypair();
const channel = "chan-1";

describe("message fold", () => {
  it("orders rows chronologically with id tiebreak and excludes other channels and non-broadcast replies", () => {
    const a = message(alice, channel, "a", 20),
      b = message(bob, channel, "b", 10),
      same = message(bob, channel, "c", 10);
    const other = message(alice, "chan-2", "elsewhere", 30);
    const reply = message(bob, channel, "reply", 25, [
      ["e", a.id, "", "reply"],
    ]);
    const broadcast = message(bob, channel, "broadcast", 26, [
      ["e", a.id, "", "reply"],
      ["broadcast", "1"],
    ]);
    const rootOnly = message(bob, channel, "root marker only", 27, [
      ["e", a.id, "", "root"],
    ]);
    const rows = foldMessages(channel, relay.pubkey, [
      a,
      b,
      same,
      other,
      reply,
      broadcast,
      rootOnly,
    ]);
    const expectedTen = [b, same]
      .sort((x, y) => y.id.localeCompare(x.id))
      .map((event) => event.id);
    expect(rows.map((row) => row.id)).toEqual([
      ...expectedTen,
      a.id,
      broadcast.id,
      rootOnly.id,
    ]);
    expect(Object.isFrozen(rows[0])).toBe(true);
    expect(rows.find((row) => row.id === broadcast.id)?.threadRootId).toBe(
      a.id,
    );
    expect(rows.find((row) => row.id === a.id)?.threadRootId).toBeUndefined();
    expect(
      rows.find((row) => row.id === rootOnly.id)?.threadRootId,
    ).toBeUndefined();
  });
  it("applies author-only deletes and latest author edit, collects reactions and signed mentions", () => {
    const a = message(alice, channel, `hello @bob`, 10, [
      ["p", bob.pubkey],
      ["p", "not-a-key"],
    ]);
    const gone = message(alice, channel, "deleted", 11);
    const spoofed = message(alice, channel, "still here", 12);
    const events = [
      a,
      gone,
      spoofed,
      signed(alice, {
        kind: 5,
        content: "",
        created_at: 12,
        tags: [["e", gone.id]],
      }),
      signed(bob, {
        kind: 5,
        content: "",
        created_at: 12,
        tags: [["e", spoofed.id]],
      }),
      signed(alice, {
        kind: 40003,
        content: "edit one",
        created_at: 13,
        tags: [["e", a.id]],
      }),
      signed(alice, {
        kind: 40003,
        content: "edit two",
        created_at: 14,
        tags: [["e", a.id]],
      }),
      signed(bob, {
        kind: 40003,
        content: "not my message",
        created_at: 15,
        tags: [["e", a.id]],
      }),
      signed(bob, {
        kind: 7,
        content: "👍",
        created_at: 15,
        tags: [["e", a.id]],
      }),
      signed(alice, {
        kind: 7,
        content: "👍",
        created_at: 16,
        tags: [["e", a.id]],
      }),
      signed(bob, {
        kind: 7,
        content: "🎉",
        created_at: 16,
        tags: [["e", a.id]],
      }),
    ];
    const rows = foldMessages(channel, relay.pubkey, events);
    expect(rows.map((row) => row.id)).toEqual([a.id, spoofed.id]);
    expect(rows[0]).toMatchObject({
      content: "edit two",
      mentions: [bob.pubkey],
      reactions: [{ content: "👍" }, { content: "🎉" }],
      replyCount: 0,
      participants: [],
    });
  });
  it("reads relay-signed thread summaries only and tolerates malformed ones", () => {
    const a = message(alice, channel, "a", 10),
      b = message(alice, channel, "b", 11),
      c = message(alice, channel, "c", 12);
    const rows = foldMessages(channel, relay.pubkey, [
      a,
      b,
      c,
      summary(relay, channel, a.id, {
        reply_count: 4,
        descendant_count: 7,
        participants: [bob.pubkey, bob.pubkey, "junk"],
      }),
      summary(bob, channel, b.id, { reply_count: 99, participants: [] }),
      signed(relay, {
        kind: 39005,
        content: "{not json",
        tags: [
          ["e", c.id],
          ["d", c.id],
          ["h", channel],
        ],
      }),
    ]);
    expect(rows.map((row) => [row.replyCount, row.participants])).toEqual([
      [4, [bob.pubkey]],
      [0, []],
      [0, []],
    ]);
  });
  it("unwraps 40002 agent envelopes and separates image markdown into attachments", () => {
    const agent = signed(bob, {
      kind: 40002,
      content: JSON.stringify({
        content:
          "See ![shot](https://x.test/a.png) and ![clip](https://x.test/b.mp4)",
      }),
      created_at: 10,
      tags: [
        ["h", channel],
        [
          "imeta",
          "url https://x.test/c.jpg",
          "m image/jpeg",
          "dim 1280x720",
          "image https://x.test/c-poster.jpg",
        ],
        ["imeta", "url http://insecure.test/d.jpg"],
      ],
    });
    const [row] = foldMessages(channel, relay.pubkey, [agent]);
    assert.exists(row);
    expect(row.content).toBe("See  and");
    expect(row.attachments).toEqual([
      {
        url: "https://x.test/c.jpg",
        video: false,
        dimensions: { width: 1280, height: 720 },
        previewUrl: "https://x.test/c-poster.jpg",
      },
      { url: "https://x.test/a.png", video: false },
      { url: "https://x.test/b.mp4", video: true },
    ]);
  });
});

describe("profiles", () => {
  it("keeps the latest self-authored kind 0 and only https pictures", () => {
    const profiles = foldProfiles([
      profile(alice, { name: "old", picture: "https://x.test/old.png" }, 1),
      profile(
        alice,
        { display_name: "Alice", picture: "http://x.test/new.png" },
        2,
      ),
      profile(bob, { name: "   " }),
      signed(relay, { kind: 0, content: "broken", tags: [] }),
    ]);
    expect(profiles.get(alice.pubkey)).toEqual({ name: "Alice" });
    expect(profiles.get(bob.pubkey)).toEqual({ name: bob.pubkey.slice(0, 10) });
    expect(profiles.get(relay.pubkey)).toEqual({
      name: relay.pubkey.slice(0, 10),
    });
  });
});

describe("discovery", () => {
  it("lists only relay-authored rosters that include the viewer, newest metadata wins, sorted by name", () => {
    const state = new DiscoveryState(alice.pubkey, relay.pubkey);
    expect(state.accept(roster(relay, "zeta", [alice.pubkey]))).toBe(true);
    expect(
      state.accept(roster(relay, "alpha", [alice.pubkey, bob.pubkey])),
    ).toBe(true);
    expect(state.accept(roster(relay, "private", [bob.pubkey]))).toBe(true);
    expect(state.accept(roster(bob, "forged", [alice.pubkey]))).toBe(false);
    expect(state.accept(metadata(relay, "alpha", "Old name", 1))).toBe(true);
    expect(state.accept(metadata(relay, "alpha", "Alpha", 2))).toBe(true);
    expect(state.accept(metadata(relay, "alpha", "Older replay", 1))).toBe(
      false,
    );
    expect(state.channels()).toEqual([
      {
        id: "alpha",
        name: "Alpha",
        members: [alice.pubkey, bob.pubkey].sort(),
      },
      { id: "zeta", name: "zeta".slice(0, 8), members: [alice.pubkey] },
    ]);
    expect(
      state.accept(roster(relay, "alpha", [bob.pubkey], 1_700_000_001)),
    ).toBe(true);
    expect(state.channels().map((channel) => channel.id)).toEqual(["zeta"]);
  });
});
