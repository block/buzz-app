import { expect, it, vi } from "vitest";
import type { AgentLibrary } from "../../features/agents/library";
import type { ChannelSummary } from "../../features/relay/contracts";
import { keypair, message } from "../../features/relay/testing";
import {
  agentNodes,
  buildAgentChannelGraph,
  GRAPH_EDGE_LIMIT,
  readAgentActivity,
  type AgentNode,
} from "./relationships";

const rizz = keypair();
const fizz = keypair();
const library: AgentLibrary = {
  definitions: [
    { id: "rizz", name: "Rizz" },
    { id: "fizz", name: "Fizz" },
    { id: "empty", name: "No identity" },
  ],
  identities: [
    { pubkey: rizz.pubkey, name: "Rizz", definitionId: "rizz" },
    { pubkey: fizz.pubkey, name: "Fizz", definitionId: "fizz" },
  ],
};
const channels: ChannelSummary[] = [
  { id: "current", name: "Current", members: [rizz.pubkey] },
  { id: "past", name: "Past", members: [] },
  { id: "unknown", name: "Unknown" },
];

it("keeps exact active identities and omits definitions without a usable identity", () => {
  expect(agentNodes(library, (key) => key === fizz.pubkey)).toEqual([
    {
      id: "definition:rizz",
      name: "Rizz",
      identityPubkeys: [rizz.pubkey],
    },
  ]);
});

it("projects current membership and verified activity into graph-ready edges", () => {
  const agents = agentNodes(library, () => false);
  const graph = buildAgentChannelGraph(channels, agents, [
    message(rizz, "past", "older", 10),
    message(rizz, "past", "newer", 20),
    { ...message(rizz, "past", "pending", 30), delivery: "sending" },
    message(fizz, "unknown", "hello", 15),
    message(fizz, "not-authorized", "hidden", 30),
  ]);
  expect(graph.edgesLimited).toBe(false);
  expect(graph.edges).toEqual([
    {
      agentId: "definition:rizz",
      channelId: "current",
      membership: "current",
      observedMessageCount: 0,
    },
    {
      agentId: "definition:rizz",
      channelId: "past",
      membership: "past",
      firstObservedAt: 10,
      lastObservedAt: 20,
      observedMessageCount: 2,
    },
    {
      agentId: "definition:fizz",
      channelId: "unknown",
      membership: "unknown",
      firstObservedAt: 15,
      lastObservedAt: 15,
      observedMessageCount: 1,
    },
  ]);
});

it("downgrades roster membership when coverage is partial", () => {
  const [agent] = agentNodes(library, () => false);
  expect(
    buildAgentChannelGraph(channels, agent ? [agent] : [], [], false).edges,
  ).toEqual([
    {
      agentId: "definition:rizz",
      channelId: "current",
      membership: "unknown",
      observedMessageCount: 0,
    },
  ]);
});

it("caps the relationship projection while preserving current edges first", () => {
  const crowdedAgent: AgentNode = {
    id: "crowded",
    name: "Crowded",
    identityPubkeys: [rizz.pubkey],
  };
  const crowdedChannels = Array.from(
    { length: GRAPH_EDGE_LIMIT + 1 },
    (_, index): ChannelSummary => ({
      id: `channel-${index}`,
      name: `Channel ${index}`,
      members: index === GRAPH_EDGE_LIMIT ? [rizz.pubkey] : [],
    }),
  );
  const activity = crowdedChannels
    .slice(0, GRAPH_EDGE_LIMIT)
    .map((channel, index) => ({
      id: String(index).padStart(64, "0"),
      pubkey: rizz.pubkey,
      created_at: index,
      kind: 9,
      content: "observed",
      tags: [["h", channel.id]],
    }));
  const graph = buildAgentChannelGraph(
    crowdedChannels,
    [crowdedAgent],
    activity,
  );
  expect(graph.edgesLimited).toBe(true);
  expect(graph.edges).toHaveLength(GRAPH_EDGE_LIMIT);
  expect(graph.edges[0]).toMatchObject({
    channelId: `channel-${GRAPH_EDGE_LIMIT}`,
    membership: "current",
  });
});

it("reads activity through the shared session with exact authors and cancellation", async () => {
  const events = [message(rizz, "current", "hello", 20)];
  const read = vi.fn().mockResolvedValue(events);
  const controller = new AbortController();
  const result = await readAgentActivity(
    { read } as never,
    [rizz.pubkey, rizz.pubkey],
    ["current", "current"],
    controller.signal,
  );
  expect(result).toEqual(events);
  expect(read).toHaveBeenCalledWith(
    [
      {
        kinds: [9],
        authors: [rizz.pubkey],
        "#h": ["current"],
        limit: 500,
      },
    ],
    { signal: controller.signal, priority: "background" },
  );
});

it("keeps explicit channel filters within the relay's 128-channel limit", async () => {
  const channelIds = Array.from(
    { length: 129 },
    (_, index) => `channel-${index}`,
  );
  const read = vi.fn().mockResolvedValue([]);

  await readAgentActivity(
    { read } as never,
    [rizz.pubkey],
    channelIds,
    new AbortController().signal,
  );

  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls.map((call) => call[0][0]["#h"])).toEqual([
    channelIds.slice(0, 128),
    channelIds.slice(128),
  ]);
  expect(
    Math.max(...read.mock.calls.map((call) => call[0][0]["#h"].length)),
  ).toBe(128);
});

it("uses eligible relay observations rather than pending outbox rows for pagination", async () => {
  const remote = Array.from({ length: 500 }, (_, index) => ({
    ...message(rizz, "current", `remote-${index}`, 1_000 - index),
    id: String(index).padStart(64, "0"),
    ...(index === 0
      ? { delivery: "accepted" as const }
      : index === 1
        ? { delivery: "seen" as const }
        : {}),
  }));
  const pending = {
    ...message(rizz, "current", "pending", 750),
    id: String(250).padStart(64, "0"),
    delivery: "sending" as const,
  };
  const read = vi
    .fn()
    .mockResolvedValueOnce([
      pending,
      ...remote.filter((event) => event.id !== pending.id),
    ])
    .mockResolvedValue([]);
  await readAgentActivity(
    { read } as never,
    [rizz.pubkey],
    ["current"],
    new AbortController().signal,
  );
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls[1]?.[0]).toEqual([
    expect.objectContaining({
      until: 501,
      before_id: String(499).padStart(64, "0"),
    }),
  ]);
});

it("keeps accepted local observations out of the relay pagination cursor", async () => {
  const remote = Array.from({ length: 500 }, (_, index) => ({
    ...message(rizz, "current", `remote-${index}`, 1_000 - index),
    id: String(index).padStart(64, "0"),
  }));
  const acceptedLocal = {
    ...message(rizz, "current", "accepted-local", 1),
    id: "f".repeat(64),
    delivery: "accepted" as const,
  };
  const read = vi
    .fn()
    .mockResolvedValueOnce([acceptedLocal, ...remote])
    .mockResolvedValue([]);

  const result = await readAgentActivity(
    { read } as never,
    [rizz.pubkey],
    ["current"],
    new AbortController().signal,
  );

  expect(result).toContainEqual(acceptedLocal);
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls[1]?.[0]).toEqual([
    expect.objectContaining({
      until: 501,
      before_id: String(499).padStart(64, "0"),
    }),
  ]);
});

it("shares the aggregate ceiling fairly across author batches", async () => {
  const authors = Array.from({ length: 301 }, (_, index) => `author-${index}`);
  const calls = new Map<string, number>();
  const read = vi.fn(
    async ([filter]: [{ authors: string[]; limit: number }]) => {
      const batch = filter.authors[0] ?? "";
      const page = calls.get(batch) ?? 0;
      calls.set(batch, page + 1);
      return Array.from({ length: filter.limit }, (_, index) => {
        const sequence = page * filter.limit + index;
        return {
          id: `${batch === authors[300] ? "b" : "a"}${String(sequence).padStart(63, "0")}`,
          pubkey: batch,
          created_at: (batch === authors[300] ? 3_000 : 2_000) - sequence,
          kind: 9,
          content: "",
          tags: [["h", "current"]],
        };
      });
    },
  );
  const result = await readAgentActivity(
    { read } as never,
    authors,
    ["current"],
    new AbortController().signal,
  );
  expect(result).toHaveLength(2_000);
  expect(new Set(read.mock.calls.map((call) => call[0][0].limit))).toEqual(
    new Set([500]),
  );
  expect(result[0]?.pubkey).toBe(authors[300]);
  expect(read).toHaveBeenCalledTimes(4);
});

it("removes ineligible outbox rows before applying the aggregate ceiling", async () => {
  const authors = Array.from({ length: 301 }, (_, index) => `author-${index}`);
  const read = vi.fn(async ([filter]: [{ authors: string[] }]) => {
    const pubkey = filter.authors[0] ?? "";
    if (pubkey === authors[300])
      return [
        {
          id: "newest-eligible",
          pubkey,
          created_at: 4_000,
          kind: 9,
          content: "",
          tags: [["h", "current"]],
          delivery: "seen" as const,
        },
      ];
    return [
      ...Array.from({ length: 2_000 }, (_, index) => ({
        id: `pending-${index}`,
        pubkey,
        created_at: 10_000 - index,
        kind: 9,
        content: "",
        tags: [["h", "current"]],
        delivery: "sending" as const,
      })),
      {
        id: "older-eligible",
        pubkey,
        created_at: 1_000,
        kind: 9,
        content: "",
        tags: [["h", "current"]],
      },
    ];
  });

  const result = await readAgentActivity(
    { read } as never,
    authors,
    ["current"],
    new AbortController().signal,
  );

  expect(result.map((event) => event.id)).toEqual([
    "newest-eligible",
    "older-eligible",
  ]);
});
