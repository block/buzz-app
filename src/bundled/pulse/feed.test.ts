import { expect, it } from "vitest";
import { keypair, message, signed } from "../../features/relay/testing";
import { channelLabel, filterRows, pulseRows, visibleChannels } from "./feed";
import type { ChannelSummary } from "../../features/relay/contracts";
const user = keypair();
const channels: ChannelSummary[] = [
  { id: "a", name: "Design" },
  { id: "b", name: "B" },
  {
    id: "dm",
    name: "DM",
    channelType: "dm",
    hidden: true,
    participants: [user.pubkey],
  },
  { id: "hidden", name: "Hidden", hidden: true },
  { id: "archived", name: "Archived", archived: true },
];
it("uses only visible joined channels and folded roots, with stable chronological ordering", () => {
  const a = message(user, "a", "First", 1);
  const b = message(user, "b", "Second", 2);
  const events = [
    a,
    b,
    message(user, "a", "Reply", 3, [["e", a.id, "", "reply"]]),
    message(user, "hidden", "Secret", 4),
    message(user, "archived", "Old", 5),
    message(user, "unknown", "Unknown", 6),
  ];
  expect(visibleChannels(channels).map((c) => c.id)).toEqual(["a", "b", "dm"]);
  expect(pulseRows(events, channels).map((row) => row.id)).toEqual([
    b.id,
    a.id,
  ]);
  expect(pulseRows([...events].reverse(), channels)).toEqual(
    pulseRows(events, channels),
  );
});
it("uses shared edit/delete semantics and preserves delivery uncertainty", () => {
  const root = message(user, "a", "Before", 1);
  const edit = signed(user, {
    kind: 40003,
    content: "After",
    created_at: 2,
    tags: [
      ["h", "a"],
      ["e", root.id],
    ],
  });
  expect(pulseRows([root, edit], channels)[0]?.content).toBe("After");
  expect(
    pulseRows([root, { ...edit, delivery: "failed" }], channels)[0]?.content,
  ).toBe("Before");
  expect(
    pulseRows(
      [{ ...root, delivery: "unknown", error: "Timed out" }],
      channels,
    )[0],
  ).toMatchObject({ delivery: "unknown", deliveryError: "Timed out" });
  const deletion = signed(user, {
    kind: 5,
    content: "",
    tags: [
      ["h", "a"],
      ["e", root.id],
    ],
  });
  expect(pulseRows([root, edit, deletion], channels)).toEqual([]);
  expect(
    pulseRows(
      [root],
      channels.filter((c) => c.id !== "a"),
    ),
  ).toEqual([]);
});
it("For you uses exact notification identity or DM membership, not prose or invented unread status", () => {
  const prose = message(user, "a", "@Reader please review", 3);
  const mention = message(user, "b", "A request", 2, [["p", user.pubkey]]);
  const dm = message(user, "dm", "Hello", 1);
  const rows = pulseRows([prose, mention, dm], channels);
  expect(
    filterRows(rows, channels, new Map(), "for-you", "", user.pubkey).map(
      (row) => row.id,
    ),
  ).toEqual([mention.id, dm.id]);
  expect(
    filterRows(rows, channels, new Map(), "search", "design").map(
      (row) => row.id,
    ),
  ).toEqual([prose.id]);
});
it("groups one newest matching source per channel and searches current profile labels", () => {
  const events = [
    message(user, "a", "one", 1),
    message(user, "a", "two", 2),
    message(user, "dm", "hello", 3),
  ];
  const profiles = new Map([[user.pubkey, { name: "Alice" }]]);
  const rows = pulseRows(events, channels);
  expect(filterRows(rows, channels, profiles, "all", "")).toHaveLength(2);
  expect(
    filterRows(rows, channels, profiles, "search", "one")[0]?.content,
  ).toBe("one");
  expect(
    channelLabel(
      { id: "dm", name: "DM", channelType: "dm", participants: [user.pubkey] },
      profiles,
    ),
  ).toBe("Alice");
  expect(
    channelLabel(
      { id: "self", name: "Self", channelType: "dm", participants: [] },
      profiles,
    ),
  ).toBe("Notes to self");
});
