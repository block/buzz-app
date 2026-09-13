import { expect, it } from "vitest";
import { buildAgentDashboard, buildAgentFocusNetwork } from "./dashboard";
import type { AgentChannelGraph } from "./relationships";

const graph: AgentChannelGraph = {
  agents: [
    { id: "rizz", name: "Rizz", identityPubkeys: ["r"] },
    { id: "fizz", name: "Fizz", identityPubkeys: ["f"] },
    { id: "honey", name: "Honey", identityPubkeys: ["h"] },
  ],
  channels: [
    { id: "map", name: "Map", kind: "stream", archived: false },
    { id: "design", name: "Design", kind: "forum", archived: false },
    { id: "past", name: "Past", kind: "stream", archived: false },
  ],
  edges: [
    {
      agentId: "rizz",
      channelId: "map",
      membership: "current",
      firstObservedAt: 10,
      lastObservedAt: 20,
      observedMessageCount: 4,
    },
    {
      agentId: "rizz",
      channelId: "design",
      membership: "current",
      observedMessageCount: 0,
    },
    {
      agentId: "rizz",
      channelId: "past",
      membership: "past",
      firstObservedAt: 2,
      lastObservedAt: 3,
      observedMessageCount: 2,
    },
    {
      agentId: "fizz",
      channelId: "design",
      membership: "current",
      firstObservedAt: 12,
      lastObservedAt: 18,
      observedMessageCount: 3,
    },
    {
      agentId: "honey",
      channelId: "past",
      membership: "unknown",
      firstObservedAt: 1,
      lastObservedAt: 1,
      observedMessageCount: 1,
    },
  ],
  edgesLimited: false,
};

it("builds agent-first totals and orders current work before history", () => {
  const dashboard = buildAgentDashboard(graph);
  expect(dashboard.map(({ agent }) => agent.name)).toEqual([
    "Rizz",
    "Fizz",
    "Honey",
  ]);
  expect(dashboard[0]).toMatchObject({
    currentChannelCount: 2,
    pastChannelCount: 1,
    unknownChannelCount: 0,
    observedMessageCount: 6,
    firstObservedAt: 2,
    lastObservedAt: 20,
  });
  expect(dashboard[0]?.relationships.map(({ channel }) => channel.id)).toEqual([
    "map",
    "design",
    "past",
  ]);
});

it("focuses one agent and finds collaborators through displayed channels", () => {
  const dashboard = buildAgentDashboard(graph);
  const focus = buildAgentFocusNetwork(dashboard, "rizz", 2, 1);
  expect(focus?.channels.map(({ channel }) => channel.id)).toEqual([
    "map",
    "design",
  ]);
  expect(focus?.collaborators).toHaveLength(1);
  expect(focus?.collaborators[0]).toMatchObject({
    row: { agent: { id: "fizz" } },
    channelIds: ["design"],
  });
  expect(focus?.channelsLimited).toBe(true);
  expect(focus?.collaboratorsLimited).toBe(false);
});
