import { expect, it } from "vitest";
import type { ReadEvent } from "../../features/drafts-sent/model";
import type { ChannelSummary } from "../../features/relay/contracts";
import { agentWorkRows, agentWorkTarget, missingRoots } from "./agent-work";

const viewer = "a".repeat(64);
const agent = "b".repeat(64);
const stranger = "c".repeat(64);
const hex = (digit: string) => digit.repeat(64);
const channel = (
  id: string,
  channelType: ChannelSummary["channelType"],
  lastActivityAt = 0,
) => ({ id, name: id, channelType, lastActivityAt }) as ChannelSummary;
const message = (
  id: string,
  pubkey: string,
  at: number,
  channelId: string,
  rootId?: string,
  content = `message ${id.slice(0, 1)}`,
) =>
  ({
    id,
    pubkey,
    kind: 9,
    created_at: at,
    content,
    tags: [
      ["h", channelId],
      ...(rootId
        ? [
            ["e", rootId, "", "root"],
            ["e", rootId, "", "reply"],
          ]
        : []),
    ],
  }) as ReadEvent;
const rows = (input: Partial<Parameters<typeof agentWorkRows>[0]>) =>
  agentWorkRows({
    channels: [],
    sent: [],
    agentEvents: [],
    roots: [],
    agents: new Set([agent]),
    viewer,
    ...input,
  });

it("lists Solo chats and threads you and your agent both wrote in, newest first", () => {
  const result = rows({
    channels: [
      channel("solo", "solo", 50),
      channel("team", "stream"),
      channel("quiet", "stream"),
    ],
    sent: [
      // Your root, which your agent answered.
      message(
        hex("1"),
        viewer,
        100,
        "team",
        undefined,
        "**Fix** the build\nmore",
      ),
      // Your reply to your agent's root.
      message(hex("3"), viewer, 30, "team", hex("2")),
      // A thread no agent of yours wrote in.
      message(hex("4"), viewer, 200, "quiet"),
    ],
    agentEvents: [
      message(hex("5"), agent, 120, "team", hex("1")),
      message(hex("2"), agent, 20, "team", undefined, "Agent's root"),
      // Someone else's agent doesn't count.
      message(hex("6"), stranger, 300, "quiet", hex("4")),
    ],
  });
  expect(result.map(({ id, label }) => ({ id, label }))).toEqual([
    {
      id: `thread:team:${hex("1")}`,
      label: "Fix the build more",
    },
    // You both talk at the team's top level too.
    { id: "chat:team", label: "team" },
    { id: "solo:solo", label: "solo" },
    { id: `thread:team:${hex("2")}`, label: "Agent's root" },
  ]);
});

it("leaves out DMs and Solo threads, and asks for roots it can't name", () => {
  const result = rows({
    channels: [
      channel("dm", "dm"),
      channel("solo", "solo"),
      channel("team", "stream"),
    ],
    sent: [
      message(hex("1"), viewer, 10, "dm", hex("9")),
      message(hex("2"), viewer, 10, "solo", hex("8")),
      message(hex("3"), viewer, 10, "team", hex("7")),
    ],
    agentEvents: [
      message(hex("4"), agent, 11, "dm", hex("9")),
      message(hex("5"), agent, 11, "solo", hex("8")),
      message(hex("6"), agent, 11, "team", hex("7")),
    ],
  });
  expect(result.map(({ id }) => id)).toEqual([
    `thread:team:${hex("7")}`,
    "solo:solo",
  ]);
  expect(missingRoots(result)).toEqual([hex("7")]);
  const named = rows({
    channels: [channel("team", "stream")],
    sent: [message(hex("3"), viewer, 10, "team", hex("7"))],
    agentEvents: [message(hex("6"), agent, 11, "team", hex("7"))],
    roots: [
      message(hex("7"), stranger, 1, "team", undefined, "Their question"),
    ],
  });
  expect(named[0]?.label).toBe("Their question");
  expect(missingRoots(named)).toEqual([]);
});

it("caps the list at 50 and opens a thread beside its channel", () => {
  const many = Array.from({ length: 60 }, (_, index) =>
    channel(`solo-${index}`, "solo", index),
  );
  const result = rows({ channels: many });
  expect(result).toHaveLength(50);
  expect(result[0]?.id).toBe("solo:solo-59");
  const scope = { viewer, communityOrigin: "https://example.test" };
  expect(
    agentWorkTarget({ channelId: "team", rootId: hex("1") }, scope),
  ).toEqual({
    version: 1,
    kind: "conversation",
    scope,
    channelId: "team",
    messageId: hex("1"),
    threadRootId: hex("1"),
  });
  expect(agentWorkTarget({ channelId: "solo" }, scope)).toEqual({
    version: 1,
    kind: "conversation",
    scope,
    channelId: "solo",
  });
});
