import { expect, it } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import { threadAgentGroups } from "./thread-agent-groups";
const row = (
  id: string,
  authorId: string,
  mentions: string[] = [],
): ChannelMessage => ({
  id,
  authorId,
  mentions,
  channelId: "a",
  createdAt: 1,
  content: id,
  attachments: [],
  reactions: [],
  participants: [],
  replyCount: 0,
  audience: "agents",
});
const root = row("root", "human", ["a", "b", "c"]);
const known = new Set(["a", "b", "c"]);
it("keeps the same boundary from pending through coordination and settlement", () => {
  for (const replies of [
    [],
    [row("one", "a")],
    [row("one", "a"), row("two", "b"), row("three", "c")],
  ]) {
    const pending =
      replies.length < 3 ? { message: root, agents: ["c"] } : undefined;
    const blocks = threadAgentGroups(root, replies, known, pending);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: "agents",
      id: "root",
      agents: ["a", "b", "c"],
      rows: replies,
    });
  }
});
it("leaves human/unknown/system rows in order, with pending in its original segment", () => {
  const human = row("followup", "human");
  const system = {
    ...row("membership", "a"),
    membership: { type: "member_joined" as const, actor: "a", target: "b" },
  };
  const pending = { message: root, agents: ["a"] };
  const blocks = threadAgentGroups(
    root,
    [
      human,
      row("reply", "b"),
      row("unknown", "other"),
      system,
      { ...row("envelope", "e"), agentEnvelope: true },
    ],
    known,
    pending,
  );
  expect(
    blocks.map((b) => (b.kind === "message" ? b.row.id : `agents:${b.id}`)),
  ).toEqual([
    "agents:root",
    "followup",
    "agents:followup",
    "unknown",
    "membership",
    "agents:membership",
  ]);
  expect(blocks[0]).toMatchObject({ request: pending, rows: [] });
  expect(blocks[2]).toMatchObject({
    request: undefined,
    rows: [row("reply", "b")],
  });
});
it("keeps viewer visible even with conflicting agent metadata and does not invent an empty group", () => {
  const viewer = { ...row("followup", "human"), agentEnvelope: true as const };
  expect(
    threadAgentGroups(
      root,
      [viewer],
      new Set([...known, "human"]),
      undefined,
      "human",
    ),
  ).toEqual([{ kind: "message", row: viewer }]);
  expect(threadAgentGroups(root, [], known, undefined)).toEqual([]);
});
it("does not invent a tail after a human while an earlier request remains pending", () => {
  const human = row("followup", "human");
  const blocks = threadAgentGroups(root, [human], known, {
    message: root,
    agents: ["a"],
  });
  expect(blocks).toHaveLength(2);
  expect(blocks[0]).toMatchObject({ id: "root", tail: false });
  expect(blocks[1]).toEqual({ kind: "message", row: human });
});

it("keeps human-facing and legacy replies visible without inferring finality from prose", () => {
  const coordination = row("coordination", "a");
  const visible = [
    { ...row("human-facing", "b"), audience: "everyone" as const },
    { ...row("Final plan", "a"), audience: undefined },
    { ...row("Coordination please review", "a"), audience: undefined },
  ].map(({ audience, ...message }) =>
    audience ? { ...message, audience } : message,
  );
  const blocks = threadAgentGroups(
    root,
    [coordination, ...visible],
    known,
    undefined,
  );
  expect(blocks[0]).toMatchObject({ kind: "agents", rows: [coordination] });
  expect(blocks.slice(1)).toEqual(
    visible.map((row) => ({ kind: "message", row })),
  );
});
