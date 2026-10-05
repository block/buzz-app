import { expect, it, vi } from "vitest";
import type {
  Profile,
  RetainedChannelMessage,
} from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import {
  createRetainedSessions,
  personalSessions,
  personalSessionTitle,
} from "./retained-sessions";
const viewer = "v",
  agent = "a".repeat(64);
const row = (
  id: string,
  patch: Partial<RetainedChannelMessage> = {},
): RetainedChannelMessage => ({
  id,
  channelId: "c",
  authorId: viewer,
  createdAt: 1,
  excerpt: id,
  threadRootId: undefined,
  mentions: [agent],
  participants: [],
  edited: false,
  quietSession: false,
  chipSession: false,
  ...patch,
});
it("requires viewer authorship or strict summary participation, never received mentions or reading", () => {
  const rows = [
    row("root", { authorId: "human", mentions: [viewer, agent] }),
    row("reply", { authorId: agent, threadRootId: "root", mentions: [viewer] }),
  ];
  expect(personalSessions(rows, viewer, new Set([agent])).size).toBe(0);
  expect(
    personalSessions(
      [...rows, row("mine", { threadRootId: "root", mentions: [] })],
      viewer,
      new Set([agent]),
    )
      .get("c")
      ?.map((item) => item.rootId),
  ).toEqual(["root"]);
  expect(
    personalSessions(
      [row("summary", { authorId: "human", participants: [viewer] })],
      viewer,
      new Set([agent]),
    )
      .get("c")
      ?.map((item) => item.rootId),
  ).toEqual(["summary"]);
});
it("classifies loaded reply keys, exact channels and edited root mentions with existing quiet/chip rules", () => {
  const roots = [
    row("ordinary", { edited: true }),
    row("quiet", { edited: true, quietSession: true }),
    row("chip", { edited: true, chipSession: true }),
    row("later", { mentions: [] }),
  ];
  const evidence = [
    ...roots,
    row("reply", { authorId: "human", threadRootId: "later", createdAt: 4 }),
    row("other", {
      channelId: "elsewhere",
      threadRootId: "ordinary",
      createdAt: 9,
    }),
  ];
  expect(
    personalSessions(evidence, viewer, new Set([agent]))
      .get("c")
      ?.map((item) => [item.rootId, item.lastMessageAt]),
  ).toEqual([
    ["later", 4],
    ["chip", 1],
    ["quiet", 1],
  ]);
  expect(personalSessions(evidence, viewer, new Set()).size).toBe(0);
});
it("caps at five with canonical roots, latest conversational time and deterministic ties", () => {
  const roots = Array.from({ length: 8 }, (_, index) =>
    row(`${index}`, { createdAt: index + 1 }),
  );
  const result = personalSessions(
    [
      ...roots,
      row("0", { createdAt: 1 }),
      row("reply", { threadRootId: "0", authorId: "human", createdAt: 99 }),
    ],
    viewer,
    new Set([agent]),
  );
  expect(result.get("c")?.map((item) => item.rootId)).toEqual([
    "0",
    "7",
    "6",
    "5",
    "4",
  ]);
});
it("shares one passive source subscription and projection across channel consumers; clears on release/disable", () => {
  const listeners = new Set<() => void>();
  const subscribe = vi.fn((listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  let rows = [row("root")];
  let profiles = new Map([[agent, { isAgent: true }]]);
  const library = { identities: [] };
  const session = {
    viewer,
    channels: { retained: () => rows, subscribeRetained: subscribe },
    profiles: { snapshot: () => profiles, subscribe },
    agentChoices: { snapshot: () => library, subscribe },
    agentActivity: { snapshot: () => ({ turns: [] }), subscribe },
  } as unknown as RelaySession;
  const factory = createRetainedSessions(),
    owner = factory.forSession(session);
  const first = vi.fn(),
    second = vi.fn();
  const stop = owner.subscribe(first),
    stop2 = owner.subscribe(second);
  expect(subscribe).toHaveBeenCalledTimes(4);
  const before = owner.snapshot("c");
  expect(owner.snapshot("c")).toBe(before);
  expect(owner.snapshot("other")).toEqual([]);
  expect(owner.snapshot("c")).toBe(before);
  profiles = new Map([[agent, { isAgent: true, name: "Renamed" }]]);
  for (const listener of listeners) listener();
  expect(owner.snapshot("c")).toBe(before);
  profiles = new Map();
  for (const listener of listeners) listener();
  expect(owner.snapshot("c")).toEqual([]);
  rows = [];
  expect(owner.snapshot("c")).toEqual([]);
  stop();
  stop2();
  expect(listeners.size).toBe(0);
  const unmount = owner.subscribe(first);
  factory.dispose();
  expect(listeners.size).toBe(0);
  unmount();
});

it("shares passive activity evidence, fences reset/retarget/disposal, and never changes personal ordering", () => {
  const root = "1".repeat(64),
    reply = "2".repeat(64);
  const listeners = new Set<() => void>();
  const subscribe = vi.fn((listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  let rows = [row(root), row(reply, { threadRootId: root, createdAt: 2 })];
  let turns: import("../../features/agents/activity").ActivityTurn[] = [];
  const profiles = new Map([[agent, { isAgent: true }]]),
    library = { identities: [] };
  const activate = vi.fn(),
    ensure = vi.fn();
  const session = {
    viewer,
    channels: { retained: () => rows, subscribeRetained: subscribe, ensure },
    profiles: { snapshot: () => profiles, subscribe, ensure },
    agentChoices: { snapshot: () => library, subscribe, refresh: ensure },
    agentActivity: { snapshot: () => ({ turns }), subscribe, activate },
  } as unknown as RelaySession;
  const factory = createRetainedSessions(),
    owner = factory.forSession(session);
  const stop = owner.subscribe(() => {}),
    stop2 = owner.subscribe(() => {});
  const order = owner.snapshot("c");
  expect(subscribe).toHaveBeenCalledTimes(4);
  expect(owner.snapshotActivity("c", root)).toBeUndefined();
  turns = [
    {
      agent,
      turnId: "one",
      channelId: "c",
      timestamp: 1,
      state: "working",
      triggeringEventIds: [reply],
    },
  ];
  for (const listener of listeners) listener();
  expect(owner.snapshotActivity("c", root)).toBe("working");
  expect(owner.snapshotActivity("other", root)).toBeUndefined();
  expect(owner.snapshotActivity("c", reply)).toBeUndefined();
  expect(owner.snapshot("c")).toBe(order);
  turns = turns.map((turn) => ({ ...turn, state: "unknown" }));
  expect(owner.snapshotActivity("c", root)).toBe("unknown");
  rows = [];
  expect(owner.snapshotActivity("c", root)).toBeUndefined();
  rows = [row(root), row(reply, { threadRootId: root })];
  turns = [];
  expect(owner.snapshotActivity("c", root)).toBeUndefined();
  expect(activate).not.toHaveBeenCalled();
  expect(ensure).not.toHaveBeenCalled();
  const replacement = factory.forSession({
    ...session,
    channels: { ...session.channels, retained: () => [] },
  });
  expect(replacement.snapshotActivity("c", root)).toBeUndefined();
  stop();
  stop2();
  expect(listeners.size).toBe(0);
  factory.dispose();
  rows = [row(root)];
  turns = [
    {
      agent,
      turnId: "late",
      channelId: "c",
      timestamp: 2,
      state: "working",
      triggeringEventIds: [root],
    },
  ];
  // Even an inactive old owner cannot resurrect its cache after plugin disposal.
  expect(owner.snapshotActivity("c", root)).toBeUndefined();
  expect(replacement.snapshotActivity("c", root)).toBeUndefined();
  expect(owner.snapshot("c")).toEqual([]);
});

const bubbles = "b".repeat(64),
  human = "c".repeat(64);
const names = new Map<string, Profile>([
  [agent, { name: "Blossom", isAgent: true }],
  [bubbles, { name: "Bubbles", isAgent: true }],
  [human, { name: "Wes" }],
]);
const known = new Set([agent, bubbles]);
const namedRow = (
  content: string,
  patch: Partial<RetainedChannelMessage> = {},
) =>
  row("root", {
    excerpt: content.slice(0, 160).trim().replace(/\s+/g, " "),
    titleSource: content.slice(0, 161),
    mentions: [agent, bubbles, human],
    ...patch,
  });
it.each([
  ["@Blossom   investigate the task", "investigate the task"],
  ["Please @Blossom investigate", "Please investigate"],
  ["Investigate this @Blossom", "Investigate this"],
  ["@Blossom ask @Bubbles about this @Blossom", "ask about this"],
  ["@Blossom", "Session with Blossom"],
  ["@Blossom @Bubbles @Blossom", "Session with Blossom, Bubbles"],
  ["@Blossom ask @Wes and @unknown", "ask @Wes and @unknown"],
  ["@Blossoming and @Blossom_foo", "@Blossoming and @Blossom_foo"],
  ["`@Blossom` then @Bubbles", "`@Blossom` then"],
  ["```ts\n@Blossom\n```\n@Bubbles", "```ts @Blossom ```"],
  ["    @Blossom\n@Bubbles", "@Blossom"],
  [" \t@Blossom\n@Bubbles", "@Blossom"],
  ["  ~~~\n@Blossom\n~~~", "~~~ @Blossom ~~~"],
  ["\n    @Blossom", "@Blossom"],
  ["@Blossom, please!", ", please!"],
  ["[@Blossom](https://example.test)", "[@Blossom](https://example.test)"],
  ["https://example.test/@Blossom", "https://example.test/@Blossom"],
])(
  "derives only sidebar text from exact safe tagged mentions: %s",
  (content, expected) => {
    expect(personalSessionTitle(namedRow(content), known, names)).toBe(
      expected,
    );
  },
);
it.each([
  ">     @Blossom\n\n@Blossom",
  "``a ``` b ` @Blossom `` then @Blossom",
  `[click @Blossom](https://example.test/${"x".repeat(180)})`,
  `![click @Blossom](https://example.test/${"x".repeat(180)})`,
])(
  "preserves the original sidebar excerpt for uncertain syntax: %s",
  (content) => {
    const root = namedRow(content);
    expect(personalSessionTitle(root, known, names)).toBe(root.excerpt);
  },
);
it("preserves untagged, unresolved, invalid, ambiguous and edited mentions, including quiet/chip roots", () => {
  const content = "@Blossom investigate";
  for (const patch of [
    { mentions: [] },
    { mentions: ["invalid"] },
    { edited: true },
    { edited: true, quietSession: true },
    { edited: true, chipSession: true },
    { titleSource: undefined },
  ]) {
    expect(
      personalSessionTitle(
        namedRow(content, patch as Partial<RetainedChannelMessage>),
        known,
        names,
      ),
    ).toBe(content);
  }
  expect(personalSessionTitle(namedRow(content), known, new Map())).toBe(
    content,
  );
  expect(
    personalSessionTitle(
      namedRow(content),
      known,
      new Map([[agent, { name: "Blossom\n" }]]),
    ),
  ).toBe(content);
  expect(
    personalSessionTitle(
      namedRow(content),
      known,
      new Map([
        [agent, { name: "Blossom" }],
        [human, { name: "Blossom" }],
      ]),
    ),
  ).toBe(content);
});
it("uses reference tags for titles but never adds reference-only session eligibility", () => {
  const root = namedRow("@Blossom investigate", {
    mentions: [],
    mentionReferences: [agent],
  });
  expect(personalSessionTitle(root, known, names)).toBe("investigate");
  expect(personalSessions([root], viewer, known, names).size).toBe(0);
});
it("preserves incomplete tokens, longer known labels and key qualifiers at the raw cut", () => {
  const longer = new Map<string, Profile>([
    ...names,
    [bubbles, { name: "Blossom Smith", isAgent: true }],
  ]);
  for (const content of [
    `${"x".repeat(151)} @Blossoming`,
    `${"x".repeat(150)} @Blossom Smith`,
    `${"x".repeat(147)} @Blossom Smith`,
    `${"x".repeat(150)} @Blossom (${human})`,
    `${"x".repeat(145)} @Blossom (${human})`,
    `[@Blossom ${"x".repeat(200)}](https://example.test)`,
    `[@Blossom](https://example.test/${"x".repeat(200)})`,
  ]) {
    const root = namedRow(content);
    expect(personalSessionTitle(root, known, longer)).toBe(root.excerpt);
  }
  const complete = namedRow(`@Blossom ${"x".repeat(200)}`);
  expect(personalSessionTitle(complete, known, names)).toBe("x".repeat(151));
});
it("reacts to cached profile/choice names, preserves unchanged arrays, and starts no reads", () => {
  const subscribe = vi.fn(() => () => {}),
    ensure = vi.fn();
  const rows = [namedRow("@Blossom investigate")];
  let profiles = new Map([[agent, { isAgent: true, name: "Old" }]]);
  let choices = {
    identities: [] as { pubkey: string; name: string; managed: boolean }[],
    complete: false,
    pending: true,
  };
  const session = {
    viewer,
    channels: { retained: () => rows, subscribeRetained: subscribe, ensure },
    profiles: { snapshot: () => profiles, subscribe, ensure },
    agentChoices: {
      snapshot: () => choices,
      subscribe,
      ensure,
      refresh: ensure,
    },
    agentActivity: { snapshot: () => ({ turns: [] }), subscribe },
    observe: ensure,
  } as unknown as RelaySession;
  const factory = createRetainedSessions(),
    owner = factory.forSession(session);
  const stop = owner.subscribe(() => {});
  expect(owner.snapshot("c")[0]?.title).toBe("@Blossom investigate");
  profiles = new Map([[agent, { isAgent: true, name: "Blossom" }]]);
  expect(owner.snapshot("c")[0]?.title).toBe("investigate");
  const before = owner.snapshot("c");
  profiles = new Map(profiles);
  expect(owner.snapshot("c")).toBe(before);
  profiles = new Map([[agent, { isAgent: true, name: "Old" }]]);
  expect(owner.snapshot("c")[0]?.title).toBe("@Blossom investigate");
  choices = {
    ...choices,
    identities: [{ pubkey: agent, name: "Blossom", managed: true }],
  };
  expect(owner.snapshot("c")[0]?.title).toBe("investigate");
  profiles = new Map();
  expect(owner.snapshot("c")[0]?.title).toBe("investigate");
  choices = { ...choices, identities: [] };
  expect(owner.snapshot("c")).toEqual([]);
  expect(ensure).not.toHaveBeenCalled();
  stop();
  factory.dispose();
});
