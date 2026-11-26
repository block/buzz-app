import { describe, expect, it } from "vitest";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { InboxItem } from "../../features/relay/inbox";
import type { ReadEvent } from "../../features/drafts-sent/model";
import { ownActivity, withOwnActivity } from "./own-activity";

const viewer = "v".repeat(64);
const hex = (n: number) => n.toString(16).padStart(64, "0");
const channel = (id: string, channelType: string) =>
  ({ id, channelType, members: [viewer] }) as unknown as ChannelSummary;
const channels = [
  channel("room", "stream"),
  channel("dm", "dm"),
  channel("solo", "solo"),
];
const sent = (
  n: number,
  channelId: string,
  createdAt: number,
  extra: string[][] = [],
): ReadEvent => ({
  id: hex(n),
  pubkey: viewer,
  kind: 9,
  created_at: createdAt,
  content: `Message ${n}`,
  tags: [["h", channelId], ...extra],
});
const reply = (root: number) => [
  ["e", hex(root), "", "root"],
  ["e", hex(root), "", "reply"],
];
const item = (id: string, createdAt: number) =>
  ({ id, channelId: id.split(":")[0], createdAt }) as unknown as InboxItem;

describe("ownActivity", () => {
  it("keeps your newest message in each conversation, grouped as Activity groups", () => {
    const own = ownActivity(
      [
        sent(1, "room", 10),
        sent(2, "room", 11, reply(1)),
        sent(3, "room", 12, reply(1)),
        sent(4, "dm", 13, reply(9)),
        sent(5, "solo", 14),
        sent(6, "solo", 15, reply(5)),
        sent(7, "gone", 16),
      ],
      viewer,
      channels,
    );
    expect([...own.keys()].sort()).toEqual(
      [`room:${hex(1)}`, "dm:dm", "solo:solo", `solo:${hex(5)}`].sort(),
    );
    expect(own.get(`room:${hex(1)}`)).toMatchObject({
      messageId: hex(3),
      rootId: hex(1),
      createdAt: 12,
    });
    // A DM is one conversation, even for a reply in one of its threads.
    expect(own.get("dm:dm")?.messageId).toBe(hex(4));
  });

  it("reads mentions from the message's own tags", () => {
    const own = ownActivity(
      [sent(1, "room", 10, [["p", "a".repeat(64)]])],
      viewer,
      channels,
    );
    expect(own.get(`room:${hex(1)}`)?.preview.mentions).toEqual([
      "a".repeat(64),
    ]);
  });
});

describe("withOwnActivity", () => {
  const own = ownActivity(
    [sent(2, "room", 30, reply(1)), sent(5, "solo", 5)],
    viewer,
    channels,
  );

  it("places a conversation by your newer message, without changing older ones", () => {
    const items = [item(`room:${hex(1)}`, 20), item("solo:solo", 10)];
    const rows = withOwnActivity(items, items, own, () => true);
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "conversation",
        createdAt: 30,
        own: expect.objectContaining({ messageId: hex(2) }),
      }),
      { kind: "conversation", item: item("solo:solo", 10), createdAt: 10 },
    ]);
  });

  it("lists conversations only you wrote in, unless Activity knows them", () => {
    const only = (all: InboxItem[]) =>
      withOwnActivity([], all, own, () => true).map((row) => row.kind);
    expect(only([])).toEqual(["own", "own"]);
    // A conversation another filter hid is still not yours alone.
    expect(only([item("solo:solo", 1)])).toEqual(["own"]);
    expect(
      withOwnActivity([], [], own, (mine) => !!mine.rootId).map(
        (row) => row.kind === "own" && row.own.id,
      ),
    ).toEqual([`room:${hex(1)}`]);
  });
});
