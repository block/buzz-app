import { expect, it } from "vitest";
import { threadActivity } from "./thread-activity";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelMessage } from "../../features/relay/contracts";
const root = "a".repeat(64),
  handoff = "b".repeat(64),
  agent = "c".repeat(64),
  peer = "d".repeat(64);
type Snapshot = ReturnType<RelaySession["agentActivity"]["snapshot"]>;
function record(
  id: string,
  author: string,
  turn: string,
  seq: number,
  kind: string,
  trigger = root,
  channelId = "alpha",
) {
  return {
    id,
    agent: author,
    kind,
    channelIds: [channelId],
    receivedAt: 1000,
    createdAt: 1,
    plaintext: JSON.stringify({
      kind,
      turnId: turn,
      channelId,
      seq,
      timestamp: new Date(1000).toISOString(),
      payload:
        kind === "turn_started"
          ? { triggeringEventIds: [trigger] }
          : {
              method: "session/update",
              params: {
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: id,
                  title: "Later tool",
                  status: "in_progress",
                },
              },
            },
    }),
  };
}
const message = {
  id: handoff,
  channelId: "alpha",
  threadRootId: root,
  content: "Handoff",
  createdAt: 1,
  mentions: [],
  attachments: [],
  reactions: [],
  participants: [],
  replyCount: 0,
  authorId: agent,
} satisfies ChannelMessage;
const snapshot = (): Snapshot => ({
  status: "listening",
  trimmed: 0,
  typing: [],
  records: [
    record("1", agent, "initial", 1, "turn_started"),
    record("2", agent, "initial", 2, "turn_completed"),
    record("3", peer, "handoff", 1, "turn_started", handoff),
    record("4", peer, "handoff", 2, "acp_read", handoff),
  ],
  turns: [
    {
      agent,
      channelId: "alpha",
      turnId: "initial",
      timestamp: 1000,
      state: "ended",
    },
    {
      agent: peer,
      channelId: "alpha",
      turnId: "handoff",
      timestamp: 1000,
      state: "working",
    },
  ],
});
it("includes later hidden-handoff turns and new agents only with loaded exact-thread evidence", () => {
  expect(
    threadActivity(snapshot(), "alpha", root).filter((e) => e.working),
  ).toEqual([]);
  const work = threadActivity(snapshot(), "alpha", root, [message]);
  expect(
    work.find((e) => e.agent === peer)?.selected.records.map((r) => r.id),
  ).toEqual(["3", "4"]);
  expect(work.find((e) => e.agent === peer)?.working).toBe(true);
  expect(work.find((e) => e.agent === agent)?.state).toBe("ended");
  for (const wrong of [
    { ...message, threadRootId: "f".repeat(64) },
    { ...message, channelId: "beta" },
  ])
    expect(
      threadActivity(snapshot(), "alpha", root, [wrong]).some(
        (e) => e.agent === peer,
      ),
    ).toBe(false);
});
it("fresh exact typing can show later work without attributing missing tool details", () => {
  const source = snapshot();
  const typing = {
    agent: peer,
    channelId: "alpha",
    threadRootId: root,
    timestamp: 1100,
    startedAt: 1100,
    working: true,
    expiresAt: 9000,
  };
  const result = threadActivity(
    { ...source, typing: [typing] },
    "alpha",
    root,
  ).find((e) => e.agent === peer);
  expect(result?.working).toBe(true);
  expect(result?.selected.records).toEqual([]);
  expect(
    threadActivity(
      { ...source, status: "interrupted", typing: [typing] },
      "alpha",
      root,
    ).some((e) => e.working),
  ).toBe(false);
  expect(
    threadActivity(
      { ...source, typing: [{ ...typing, agent, timestamp: 999 }] },
      "alpha",
      root,
    ).find((e) => e.agent === agent)?.working,
  ).toBe(false);
});
it("does not admit ambiguous starts or confuse coordination/turn completion with a visible answer", () => {
  const source = snapshot();
  const duplicate = record("5", peer, "handoff", 3, "turn_started", handoff);
  expect(
    threadActivity(
      { ...source, records: [...source.records, duplicate] },
      "alpha",
      root,
      [message],
    ).some((e) => e.agent === peer),
  ).toBe(false);
  expect(
    threadActivity({ ...source, trimmed: 1 }, "alpha", root, [message]).find(
      (e) => e.agent === agent,
    )?.state,
  ).toBe("unknown");
});

it("keeps retained linked records inspectable when their independent turn-state slot was evicted", () => {
  const source = snapshot();
  const work = threadActivity({ ...source, turns: [] }, "alpha", root, [
    message,
  ]);
  const entry = work.find((entry) => entry.agent === peer);
  expect(entry?.selected.records.map((record) => record.id)).toEqual([
    "3",
    "4",
  ]);
  expect(entry?.state).toBe("unknown");
  expect(entry?.working).toBe(false);
});
