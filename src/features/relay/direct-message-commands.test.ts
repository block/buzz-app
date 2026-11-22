import { describe, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { createDirectMessages } from "./direct-messages";
import type { ChannelSummary } from "./contracts";
import type { RelayReader } from "./reader";
import type { RelayWriter } from "./transport";
import type { ReadFilter, RelayEvent } from "./events";
import { keypair, profile, roster, signed } from "./testing";
import {
  conversationNameDetails,
  directMessageCommandRefusal,
} from "./direct-message-policy";

const dm = "11111111-1111-4111-8111-111111111111";
const next = "22222222-2222-4222-8222-222222222222";
const cut = "c".repeat(64);
const signal = () => new AbortController().signal;

function session() {
  const viewer = keypair();
  const other = keypair();
  const relay = keypair();
  let discovery: RelayEvent[] = [
    signed(relay, {
      kind: 39000,
      content: JSON.stringify({ name: "Direct message" }),
      tags: [["d", dm], ["t", "dm"], ["hidden"]],
    }),
    roster(relay, dm, [viewer.pubkey, other.pubkey]),
  ];
  const query = vi.fn(async (filters: readonly ReadFilter[]) => {
    if (filters.some((f) => f.kinds?.includes(0)))
      return [
        profile(viewer, { name: "Me" }),
        profile(other, { name: "Other" }),
      ];
    return discovery.filter((event) =>
      filters.some((filter) => filter.kinds?.includes(event.kind)),
    );
  });
  const nameDirectMessage = vi.fn(async (id: string) => {
    // The relay turns the DM into a private channel in place.
    discovery = [
      signed(relay, {
        kind: 39000,
        created_at: 1_700_000_100,
        content: JSON.stringify({ name: "Plans" }),
        tags: [
          ["d", dm],
          ["name", "Plans"],
          ["t", "stream"],
          ["private"],
          ["picture", "https://example.org/plans.png"],
        ],
      }),
      roster(relay, dm, [viewer.pubkey, other.pubkey], 1_700_000_100),
    ];
    return id;
  });
  const moveDirectMessageHistory = vi.fn(
    async (_id: string, move: { name?: string }) => {
      discovery = [
        ...discovery,
        signed(relay, {
          kind: 39000,
          created_at: 1_700_000_100,
          content: JSON.stringify({ name: move.name ?? "Direct message" }),
          tags: move.name
            ? [["d", next], ["name", move.name], ["t", "stream"], ["private"]]
            : [["d", next], ["t", "dm"], ["hidden"]],
        }),
        roster(relay, next, [viewer.pubkey, other.pubkey], 1_700_000_100),
      ];
      return { channelId: next, created: true };
    },
  );
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query,
      openDirectMessage: vi.fn(async () => dm),
      nameDirectMessage,
      moveDirectMessageHistory,
      writer: {
        kinds: [9],
        sign: async (template) => signed(viewer, template),
        publish: vi.fn<RelayWriter["publish"]>(async () => {}),
      },
    },
    { outboxStorage: { load: () => [], save: () => {} } },
  );
  return {
    owner,
    viewer,
    other,
    query,
    nameDirectMessage,
    moveDirectMessageHistory,
    dm: owner.session.directMessages,
    channel: (id: string) => owner.session.channels.get?.(id),
  };
}

describe("naming a DM", () => {
  it("turns the DM into a channel in place, with its picture", async () => {
    const t = session();
    try {
      await t.dm.open([t.other.pubkey], signal());
      expect(t.channel(dm)?.channelType).toBe("dm");
      expect(t.dm.nameable).toBe(true);
      await expect(
        t.dm.name(
          dm,
          { name: "  #Plans ", picture: "https://example.org/plans.png" },
          signal(),
        ),
      ).resolves.toBe(dm);
      expect(t.nameDirectMessage).toHaveBeenCalledWith(
        dm,
        { name: "Plans", picture: "https://example.org/plans.png" },
        expect.any(AbortSignal),
      );
      const named = t.channel(dm);
      expect(named?.channelType).toBe("stream");
      expect(named?.name).toBe("Plans");
      expect(named?.picture).toBe("https://example.org/plans.png");
      expect(named?.hidden).toBeUndefined();
    } finally {
      t.owner.dispose();
    }
  });

  it("checks the words before contacting the host and shows the host's refusal", async () => {
    const t = session();
    try {
      await t.dm.open([t.other.pubkey], signal());
      for (const details of [
        { name: " # " },
        { name: "n".repeat(256) },
        { name: "Plans", picture: "javascript:alert(1)" },
        { name: "Plans", about: "a".repeat(1001) },
      ])
        await expect(t.dm.name(dm, details, signal())).rejects.toThrow();
      expect(t.nameDirectMessage).not.toHaveBeenCalled();
      t.nameDirectMessage.mockRejectedValueOnce(
        new Error("Only people can do that. Agents can’t."),
      );
      await expect(t.dm.name(dm, { name: "Plans" }, signal())).rejects.toThrow(
        "Only people can do that.",
      );
    } finally {
      t.owner.dispose();
    }
  });

  it("is not confirmed while signed discovery still shows a DM", async () => {
    const t = session();
    try {
      await t.dm.open([t.other.pubkey], signal());
      t.nameDirectMessage.mockResolvedValueOnce(dm);
      await expect(t.dm.name(dm, { name: "Plans" }, signal())).rejects.toThrow(
        "could not be confirmed",
      );
    } finally {
      t.owner.dispose();
    }
  });
});

describe("moving a DM's history", () => {
  it("moves into a named channel from a cut", async () => {
    const t = session();
    try {
      await t.dm.open([t.other.pubkey], signal());
      await expect(
        t.dm.move(dm, { cut, name: "Plans" }, signal()),
      ).resolves.toEqual({ channelId: next, created: true });
      expect(t.moveDirectMessageHistory).toHaveBeenCalledWith(
        dm,
        { cut, name: "Plans", add: [] },
        expect.any(AbortSignal),
      );
      expect(t.channel(next)?.channelType).toBe("stream");
      // The source stays a DM.
      expect(t.channel(dm)?.channelType).toBe("dm");
    } finally {
      t.owner.dispose();
    }
  });

  it("moves into a new DM that adds someone, and offers it as opened", async () => {
    const t = session();
    const opened = vi.fn();
    t.dm.subscribeOpened(opened);
    try {
      await t.dm.open([t.other.pubkey], signal());
      opened.mockClear();
      const third = keypair().pubkey;
      await t.dm.move(dm, { cut, add: [third] }, signal());
      expect(t.channel(next)?.channelType).toBe("dm");
      expect(opened).toHaveBeenCalledExactlyOnceWith(next);
    } finally {
      t.owner.dispose();
    }
  });

  it("refuses a move that names no one and no name, or a bad cut or picture", async () => {
    const t = session();
    try {
      await t.dm.open([t.other.pubkey], signal());
      for (const options of [
        { cut },
        { cut, add: [] },
        { cut: "not-an-id", name: "Plans" },
        { cut, add: [t.viewer.pubkey] },
        { cut, add: [t.other.pubkey, t.other.pubkey] },
        { cut, add: [keypair().pubkey], picture: "https://example.org/a.png" },
        { cut, name: "Plans", picture: "ftp://example.org/a.png" },
      ])
        await expect(t.dm.move(dm, options, signal())).rejects.toThrow();
      expect(t.moveDirectMessageHistory).not.toHaveBeenCalled();
    } finally {
      t.owner.dispose();
    }
  });

  it("starts from the oldest top-level message since a time", async () => {
    const t = session();
    const since = 1_700_000_500;
    try {
      await t.dm.open([t.other.pubkey], signal());
      const author = t.other;
      const old = signed(author, {
        kind: 9,
        created_at: since + 10,
        content: "later",
        tags: [["h", dm]],
      });
      const first = signed(author, {
        kind: 9,
        created_at: since + 1,
        content: "first",
        tags: [["h", dm]],
      });
      const reply = signed(author, {
        kind: 9,
        created_at: since,
        content: "reply",
        tags: [
          ["h", dm],
          ["e", old.id, "", "root"],
          ["e", old.id, "", "reply"],
        ],
      });
      const before = signed(author, {
        kind: 9,
        created_at: since - 1,
        content: "yesterday",
        tags: [["h", dm]],
      });
      const original = t.query.getMockImplementation();
      t.query.mockImplementation(async (filters) =>
        filters.some((f) => f["#h"]?.[0] === dm && f.since !== undefined)
          ? [old, reply, before, first]
          : (original?.(filters) ?? []),
      );
      await t.dm.move(dm, { since, name: "Today" }, signal());
      expect(t.moveDirectMessageHistory).toHaveBeenCalledWith(
        dm,
        { cut: first.id, name: "Today", add: [] },
        expect.any(AbortSignal),
      );
      t.query.mockImplementation(async (filters) =>
        filters.some((f) => f["#h"]?.[0] === dm && f.since !== undefined)
          ? [before]
          : [],
      );
      await expect(
        t.dm.move(dm, { since, name: "Today" }, signal()),
      ).rejects.toThrow("There are no messages from today to move.");
    } finally {
      t.owner.dispose();
    }
  });
});

describe("a move into a named channel with a picture", () => {
  const channels = (): ChannelSummary[] => [
    {
      id: next,
      name: "Plans",
      channelType: "stream",
      members: [],
    } as ChannelSummary,
  ];
  const harness = (save: () => Promise<void>) => {
    const viewer = keypair().pubkey;
    const transport = {
      viewer,
      relayAuthor: "r".repeat(64),
      openDirectMessage: vi.fn(),
      nameDirectMessage: vi.fn(),
      moveDirectMessageHistory: vi.fn(async () => ({
        channelId: next,
        created: true,
      })),
    };
    const base = {
      channelId: next,
      version: "v",
      name: "Plans",
      description: "",
      visibility: "private" as const,
      canEdit: true,
    };
    const load = vi.fn(async () => base);
    const saveSpy = vi.fn(save);
    const service = createDirectMessages(
      transport as never,
      { read: vi.fn(async () => []) } as unknown as RelayReader,
      { list: () => ({ channels: channels() }) } as never,
      { supports: () => true } as never,
      undefined,
      new AbortController().signal,
      { read: vi.fn(async () => []) } as unknown as RelayReader,
      (async () => []) as never,
      () => undefined,
      undefined,
      { load, save: saveSpy } as never,
    );
    return { service, load, save: saveSpy, base };
  };

  it("publishes the picture through the details writer", async () => {
    const t = harness(async () => {});
    const result = await t.service.move(
      dm,
      { cut, name: "Plans", picture: "https://example.org/p.png" },
      signal(),
    );
    expect(result).toEqual({ channelId: next, created: true });
    expect(t.save).toHaveBeenCalledWith(
      t.base,
      expect.objectContaining({ picture: "https://example.org/p.png" }),
      expect.any(AbortSignal),
    );
  });

  it("reports a failed picture without failing the move that already happened", async () => {
    const t = harness(async () => {
      throw new Error("no");
    });
    await expect(
      t.service.move(
        dm,
        { cut, name: "Plans", picture: "https://example.org/p.png" },
        signal(),
      ),
    ).resolves.toEqual({ channelId: next, created: true, pictureFailed: true });
  });
});

describe("conversation naming policy", () => {
  it("canonicalizes like the relay", () => {
    expect(conversationNameDetails({ name: " ## Plans  " }).name).toBe("Plans");
    expect(
      conversationNameDetails({ name: "Plans", picture: "" }).picture,
    ).toBeUndefined();
  });

  it("words each refusal without echoing the relay", () => {
    expect(
      directMessageCommandRefusal(
        41013,
        "forbidden: only a person can name a DM",
      ),
    ).toBe("Only people can do that. Agents can’t.");
    expect(
      directMessageCommandRefusal(
        41014,
        "invalid: the cut is not a top-level message in this DM",
      ),
    ).toBe("Start from a message that isn’t a reply.");
    expect(directMessageCommandRefusal(41014, "error: db: secret")).toBe(
      "Couldn’t move this history. Try again.",
    );
    expect(directMessageCommandRefusal(41013, undefined)).toBe(
      "Couldn’t name this conversation. Try again.",
    );
  });
});
