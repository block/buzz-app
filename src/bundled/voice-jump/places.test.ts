import { describe, expect, it, vi } from "vitest";
import type {
  DecisionResult,
  Decisions,
} from "../../features/decisions/service";
import type {
  ChannelMessage,
  ChannelSummary,
  ChannelWindow,
} from "../../features/relay/contracts";
import type { InboxItem } from "../../features/relay/inbox";
import {
  type JumpPlace,
  holdsLead,
  jumpPlaces,
  pickPlace,
  placeOptions,
} from "./places";

const message = (
  id: string,
  content: string,
  createdAt: number,
  extra: Partial<ChannelMessage> = {},
) =>
  ({
    id,
    channelId: "c",
    authorId: "alice",
    createdAt,
    content,
    mentions: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
    participants: [],
    ...extra,
  }) as ChannelMessage;

const history = (
  rows: readonly ChannelMessage[],
  hasMore = true,
): ChannelWindow => ({
  channelId: "c",
  status: "ready",
  rows,
  hasMore,
  loadingOlder: false,
  error: undefined,
});

const empty = history([]);

describe("jumpPlaces", () => {
  const channels: ChannelSummary[] = [
    {
      id: "design",
      name: "design",
      channelType: "stream",
      lastActivityAt: 100,
      description: "Design reviews",
    },
    // The relay marks every DM `hidden`.
    {
      id: "dm",
      name: "",
      channelType: "dm",
      hidden: true,
      lastActivityAt: 300,
    },
    { id: "secret", name: "secret", channelType: "stream", hidden: true },
    { id: "huddle", name: "huddle", channelType: "stream", huddle: true },
    {
      id: "chat",
      name: "Plan the offsite",
      channelType: "solo",
      lastActivityAt: 200,
      preview: "Drafting the agenda",
    },
    { id: "old", name: "old", channelType: "stream", archived: true },
    { id: "sys", name: "sys", channelType: "system" },
  ];
  const windows: Record<string, ChannelWindow> = {
    design: history([
      message("m1", "Kickoff", 10),
      message("m2", "Logo options", 20, { replyCount: 3 }),
      message("m3", "a reply", 25, { threadRootId: "m2" }),
      message("m4", "Ship it", 30),
    ]),
    chat: history([message("c1", "Help me plan the offsite", 50)], false),
  };
  const activity = [
    {
      channelId: "dm",
      rootId: "t1",
      thread: true,
      preview: "Sounds good",
      authorId: "bob",
      createdAt: 400,
    },
    // Already in memory as a root, so not repeated.
    {
      channelId: "design",
      rootId: "m2",
      thread: true,
      preview: "latest",
      authorId: "bob",
      createdAt: 500,
    },
  ] as unknown as InboxItem[];
  const places = jumpPlaces({
    pages: [
      {
        key: "buzz.reminders/reminders",
        pluginId: "buzz.reminders",
        pageId: "reminders",
        name: "Reminders",
      },
      {
        key: "buzz.channels/channels",
        pluginId: "buzz.channels",
        pageId: "channels",
        name: "Messages",
        about: "Channels",
      },
    ],
    channels,
    name: (channel) => (channel.channelType === "dm" ? "Bob" : channel.name),
    window: (id) => windows[id] ?? empty,
    activity,
    author: (pubkey) => (pubkey === "alice" ? "Alice" : "Bob"),
  });

  it("lists plugin pages first, then conversations most recent first, then threads", () => {
    expect(places.map(({ key }) => key)).toEqual([
      "page:buzz.reminders/reminders",
      "page:buzz.channels/channels",
      "dm:dm",
      "chat:chat",
      "channel:design",
      "thread:t1",
      "thread:m2",
    ]);
  });

  it("describes each place from what is already loaded", () => {
    const byKey = new Map(places.map((place) => [place.key, place]));
    expect(byKey.get("page:buzz.reminders/reminders")).toMatchObject({
      kind: "page",
      pluginId: "buzz.reminders",
      pageId: "reminders",
      name: "Reminders",
    });
    expect(byKey.get("page:buzz.channels/channels")).toMatchObject({
      kind: "page",
      name: "Messages",
      about: "Channels",
    });
    expect(byKey.get("channel:design")).toMatchObject({
      name: "design",
      about: "Design reviews",
      recent: ["Alice: Kickoff", "Alice: Logo options", "Alice: Ship it"],
    });
    // Its whole history is loaded, so the first message is known.
    expect(byKey.get("chat:chat")).toMatchObject({
      kind: "chat",
      recent: ["Alice: Help me plan the offsite"],
    });
    expect(byKey.get("dm:dm")).toMatchObject({ kind: "dm", name: "Bob" });
    expect(byKey.get("thread:m2")).toMatchObject({
      channelId: "design",
      rootId: "m2",
      name: "Alice: Logo options",
      in: "design",
    });
    expect(byKey.get("thread:t1")).toMatchObject({
      channelId: "dm",
      rootId: "t1",
      in: "Bob",
    });
  });

  it("uses a conversation's preview when none of its messages are loaded", () => {
    const [place] = jumpPlaces({
      channels: channels.filter(({ id }) => id === "chat"),
      name: (channel) => channel.name,
      window: () => empty,
      activity: [],
      author: () => "Alice",
    });
    expect(place).toMatchObject({ recent: ["Drafting the agenda"] });
  });
  it("keeps plugin pages even when more than 200 conversations are loaded", () => {
    const many: ChannelSummary[] = Array.from({ length: 210 }, (_, index) => ({
      id: `c${index}`,
      name: `channel-${index}`,
      channelType: "stream",
      lastActivityAt: index + 1,
    }));
    const listed = jumpPlaces({
      pages: [
        {
          key: "example.board/board",
          pluginId: "example.board",
          pageId: "board",
          name: "Board",
        },
      ],
      channels: many,
      name: (channel) => channel.name,
      window: () => empty,
      activity: [],
      author: () => "Alice",
    });
    expect(listed).toHaveLength(200);
    expect(listed[0]).toMatchObject({
      kind: "page",
      pluginId: "example.board",
      pageId: "board",
      name: "Board",
    });
  });
});

const places: JumpPlace[] = [
  {
    key: "page:example.board/board",
    kind: "page",
    pluginId: "example.board",
    pageId: "board",
    pageKey: "example.board/board",
    name: "Review Queue",
    at: 0,
  },
  { key: "channel:a", kind: "channel", channelId: "a", name: "design", at: 2 },
  { key: "dm:b", kind: "dm", channelId: "b", name: "Dana Lee", at: 1 },
];

const deciding = (result: DecisionResult) => {
  const decide = vi.fn(async (_request: unknown) => result);
  return { decisions: { decide } as unknown as Decisions, decide };
};

const choice = (pick: string, probabilities: Record<string, number>) =>
  ({
    outcome: "answered",
    backend: "test",
    model: "jev",
    answers: {
      place: {
        type: "choice",
        choice: pick,
        confidence: probabilities[pick] ?? 0,
        probabilities,
      },
    },
  }) as const;

describe("pickPlace", () => {
  it("goes to the place Jev picks at 0.5 or more", async () => {
    const { decisions, decide } = deciding(
      choice("DM with Dana Lee", {
        "#design": 0.3,
        "DM with Dana Lee": 0.6,
        none: 0.1,
      }),
    );
    await expect(
      pickPlace(decisions, "dana", places, "wss://relay.example.org"),
    ).resolves.toEqual({
      outcome: "found",
      place: places[2],
      probability: 0.6,
      candidates: [
        { place: places[2], label: "DM with Dana Lee", probability: 0.6 },
        { place: places[1], label: "#design", probability: 0.3 },
      ],
    });
    const request = decide.mock.calls[0]?.[0] as unknown as {
      state: string;
      community: string;
      questions: { place: { options: Record<string, string> } };
    };
    expect(JSON.parse(request.state)).toEqual({
      spoken_request: "dana",
      places: [
        { option: "Page: Review Queue", kind: "page" },
        { option: "#design", kind: "channel" },
        { option: "DM with Dana Lee", kind: "dm" },
      ],
    });
    expect(Object.keys(request.questions.place.options)).toEqual([
      "Page: Review Queue",
      "#design",
      "DM with Dana Lee",
      "none",
    ]);
    expect(request.community).toBe("wss://relay.example.org");
  });

  it("finds nothing below 0.5 or for none, and reports a failure", async () => {
    for (const result of [
      choice("#design", {
        "#design": 0.49,
        "DM with Dana Lee": 0.3,
        none: 0.21,
      }),
      choice("none", { "#design": 0.04, "DM with Dana Lee": 0.01, none: 0.95 }),
    ]) {
      const { decisions } = deciding(result);
      await expect(
        pickPlace(decisions, "design", places, undefined),
      ).resolves.toMatchObject({ outcome: "none" });
    }
    const { decisions } = deciding({
      outcome: "failed",
      backend: "test",
      reason: "timeout",
    });
    await expect(
      pickPlace(decisions, "design", places, undefined),
    ).resolves.toEqual({ outcome: "failed", reason: "timeout" });
  });

  it("tells Jev which places sound like what was said", async () => {
    const { decisions, decide } = deciding(choice("none", { none: 1 }));
    await pickPlace(decisions, "open donna leigh", places, undefined);
    const first = decide.mock.calls[0]?.[0] as unknown as { state: string };
    expect(JSON.parse(first.state).places).toEqual([
      { option: "Page: Review Queue", kind: "page" },
      { option: "#design", kind: "channel" },
      { option: "DM with Dana Lee", kind: "dm", sounds_like: ["donna leigh"] },
    ]);

    const withBestie: JumpPlace[] = [
      ...places,
      {
        key: "page:buzz.bestie/bestie",
        kind: "page",
        pluginId: "buzz.bestie",
        pageId: "bestie",
        pageKey: "buzz.bestie/bestie",
        name: "Pollen",
        about: "Bestie",
        at: 0,
      },
    ];
    await pickPlace(decisions, "open besty", withBestie, undefined);
    const second = decide.mock.calls[1]?.[0] as unknown as { state: string };
    expect(JSON.parse(second.state).places.at(-1)).toEqual({
      option: "Page: Pollen",
      kind: "page",
      sounds_like: ["besty"],
      about: "Bestie",
    });
  });

  it("asks nothing without a request or places", async () => {
    const { decisions, decide } = deciding(choice("#design", { "#design": 1 }));
    await expect(pickPlace(decisions, " ", places, undefined)).resolves.toEqual(
      { outcome: "none", candidates: [] },
    );
    await expect(
      pickPlace(decisions, "design", [], undefined),
    ).resolves.toEqual({ outcome: "none", candidates: [] });
    expect(decide).not.toHaveBeenCalled();
  });
});

describe("placeOptions", () => {
  it("names each place readably and keeps the names unique", () => {
    const thread: JumpPlace = {
      key: "thread:t",
      kind: "thread",
      channelId: "a",
      rootId: "t",
      name: "Alice: Logo options",
      in: "design",
      at: 0,
    };
    expect(
      placeOptions([
        ...places,
        {
          key: "channel:c",
          kind: "channel",
          channelId: "c",
          name: "design",
          at: 0,
        },
        { key: "chat:d", kind: "chat", channelId: "d", name: "Fizz", at: 0 },
        thread,
        { ...thread, key: "thread:u", rootId: "u", name: "x".repeat(200) },
      ]),
    ).toEqual([
      "Page: Review Queue",
      "#design",
      "DM with Dana Lee",
      "#design (2)",
      "Chat with Fizz",
      "Thread in design: Alice: Logo options",
      `Thread in design: ${"x".repeat(71)}…`,
    ]);
  });
});

describe("holdsLead", () => {
  const channel = (id: string, name: string) =>
    ({
      key: `channel:${id}`,
      kind: "channel",
      channelId: id,
      name,
      at: 1,
    }) as JumpPlace;
  const jev = channel("jev", "jev");
  const clock = channel("clock", "Jev live clock canvas plugin");
  const kernel = channel("kernel", "kernel");
  const all = [jev, clock, kernel];
  const found = (place: JumpPlace, probability: number) =>
    ({ outcome: "found", place, probability, candidates: [] }) as const;

  it("jumps at once when no longer name could still be being said", () => {
    expect(
      holdsLead(undefined, found(kernel, 0.9), "take me to kernel", all).jump,
    ).toBe(true);
    expect(
      holdsLead(undefined, found(clock, 0.9), "the jev clock", all).jump,
    ).toBe(true);
  });

  it("waits a word when a longer name holds the sure one's words", () => {
    const first = holdsLead(
      undefined,
      found(jev, 0.9),
      "the conversation about the jev",
      all,
    );
    expect(first.jump).toBe(false);
    // The longer name takes over and, being the longest, goes at once.
    expect(
      holdsLead(
        first.lead,
        found(clock, 0.9),
        "the conversation about the jev clock",
        all,
      ).jump,
    ).toBe(true);
    // The same place staying sure through another word goes too.
    expect(
      holdsLead(
        first.lead,
        found(jev, 0.9),
        "the conversation about the jev",
        all,
      ).jump,
    ).toBe(false);
    expect(
      holdsLead(
        first.lead,
        found(jev, 0.9),
        "the conversation about the jev please",
        all,
      ).jump,
    ).toBe(true);
  });

  it("drops the lead when no place is sure", () => {
    const first = holdsLead(undefined, found(jev, 0.9), "take me to jev", all);
    expect(
      holdsLead(first.lead, found(jev, 0.6), "take me to jev stuff", all),
    ).toEqual({ jump: false, lead: undefined });
    expect(
      holdsLead(
        first.lead,
        { outcome: "none", candidates: [] },
        "take me to jev x",
        all,
      ).lead,
    ).toBeUndefined();
  });

  it("waits a word when a plugin page extends a channel's name", () => {
    const review = channel("review", "review");
    const reviewQueue: JumpPlace = {
      key: "page:example.rq/queue",
      kind: "page",
      pluginId: "example.rq",
      pageId: "queue",
      pageKey: "example.rq/queue",
      name: "Review Queue",
      at: 0,
    };
    const both = [reviewQueue, review];
    const first = holdsLead(undefined, found(review, 0.9), "open review", both);
    expect(first.jump).toBe(false);
    expect(
      holdsLead(first.lead, found(reviewQueue, 0.9), "open review queue", both)
        .jump,
    ).toBe(true);
  });
});
