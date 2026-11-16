import { expect, it, vi } from "vitest";
import type { TranscriptTurn } from "../../../features/agents/activity-transcript";
import type { AgentClient, AgentSession } from "../agents/client";
import type { BuilderlabSession } from "../session";
import { historyReader, mergeTurns, sessionTurns } from "./history";

const mention = "e".repeat(64);
const session: AgentSession = {
  sessionId: "s1",
  channelId: "alpha",
  threadRootId: "r".repeat(64),
  updatedAt: 0,
};
const prompt = [
  "<context>",
  "Scope: thread",
  "</context>",
  "",
  '<buzz-event type="@mention">',
  `Event ID: ${mention}`,
  "Channel: alpha",
  "From: Ada. This sender is your owner.",
  "Content: fix &lt;this&gt; &amp; ship",
  "</buzz-event>",
].join("\n");
const text = (value: string) => ({
  type: "MESSAGE_TYPE_TEXT",
  text: { text: value },
});
const request = (id: string, name: string, args: unknown) => ({
  type: "MESSAGE_TYPE_TOOL_REQUEST",
  tool_request: {
    id,
    status: "success",
    value: { name, arguments: JSON.stringify(args) },
  },
});
const result = (id: string, output: string, status = "success") => ({
  type: "MESSAGE_TYPE_TOOL_RESPONSE",
  tool_response: { id, status, results: [{ text: { text: output } }] },
});

it("groups stored messages into the turns that started before them", () => {
  const turns = sessionTurns(session, {
    turns: [
      {
        turn_id: "t2",
        mention_event_id: "f".repeat(64),
        status: "TASK_STATUS_IN_PROGRESS",
        created_at: "2000",
        updated_at: "2000",
      },
      {
        turn_id: "t1",
        mention_event_id: mention,
        status: "TASK_STATUS_COMPLETED",
        created_at: 1000,
        updated_at: 1900,
      },
    ],
    messages: [
      { id: "m1", role: "ROLE_USER", created: 1001, content: [text(prompt)] },
      {
        id: "m2",
        role: "ROLE_ASSISTANT",
        created: 1100,
        content: [
          { type: "MESSAGE_TYPE_THINKING", thinking: { thinking: "Plan" } },
          request("c1", "developer__shell", { command: "ls" }),
          request("c2", "buzz__send", { text: "Shipped" }),
        ],
      },
      {
        id: "m3",
        role: "ROLE_USER",
        created: 1200,
        content: [result("c1", "README.md"), result("c2", "sent")],
      },
      { id: "gone", role: 2, created: 1300, deleted: true, content: [] },
      { id: "m4", role: 2, created: 2100, content: [text("Working on it")] },
    ],
  });
  expect(turns.map((turn) => [turn.turnId, turn.outcome])).toEqual([
    ["t1", "ended"],
    ["t2", undefined],
  ]);
  const [first, second] = turns as [TranscriptTurn, TranscriptTurn];
  expect(first).toMatchObject({
    channelId: "alpha",
    threadRootId: session.threadRootId,
    sessionId: "s1",
    triggeringEventIds: [mention],
    newSession: true,
    startedAt: 1000,
    endedAt: 1900,
    partial: false,
  });
  expect(first.items).toMatchObject([
    { type: "prompt", text: "fix <this> & ship", author: "Ada", steer: false },
    { type: "thought", text: "Plan" },
    {
      type: "tool",
      title: "developer__shell",
      status: "completed",
      output: "README.md",
      completedAt: 1200,
    },
    { type: "message", text: "Shipped", posted: true },
  ]);
  expect(second.newSession).toBe(false);
  expect(second).not.toHaveProperty("endedAt");
  expect(second.items).toMatchObject([
    { type: "message", text: "Working on it" },
  ]);
});

it("maps stored terminal statuses, by name or number", () => {
  const outcomes = [
    4,
    5,
    7,
    8,
    "TASK_STATUS_CANCELLED",
    "TASK_STATUS_TERMINATED",
    2,
    3,
    6,
    9,
    "TASK_STATUS_INITIALIZED",
  ].map(
    (status) =>
      sessionTurns(session, {
        turns: [{ turn_id: "t", status, created_at: 1 }],
      })[0]?.outcome,
  );
  expect(outcomes).toEqual([
    "ended",
    "error",
    "stopped",
    "error",
    "stopped",
    "error",
    ...Array(5).fill(undefined),
  ]);
});

it("marks a failed tool call and a model error", () => {
  const [turn] = sessionTurns(session, {
    turns: [{ turn_id: "t", status: "TASK_STATUS_FAILED", created_at: 1 }],
    messages: [
      {
        id: "a",
        role: "ROLE_ASSISTANT",
        created: 2,
        content: [request("c", "developer__shell", { command: "false" })],
        llm_call_error_info: { is_error: true, cause: "Rate limited" },
      },
      {
        id: "b",
        role: "ROLE_USER",
        created: 3,
        content: [result("c", "exit 1", "error")],
      },
    ],
  });
  expect(turn?.error).toBe("Rate limited");
  expect(turn?.items).toMatchObject([
    { type: "tool", status: "failed", output: "exit 1" },
  ]);
});

const live = (turnId: string, partial: boolean, startedAt: number) =>
  ({
    turnId,
    partial,
    startedAt,
    items: [{ id: `${turnId}-live`, at: startedAt, type: "status", text: "" }],
  }) as unknown as TranscriptTurn;

it("keeps live turns, and a stored copy of one Buzz saw only part of", () => {
  const stored = [live("old", false, 1), live("mid", false, 2)].map((turn) => ({
    ...turn,
    items: [],
  }));
  const merged = mergeTurns(
    [
      {
        ...live("mid", true, 2),
        items: [{ id: "later", at: 5, type: "status", text: "" }],
        outcome: "stopped",
      },
      live("new", false, 3),
      live("old", false, 1),
    ],
    stored,
  );
  expect(
    merged.map((turn) => [turn.turnId, turn.items.length, turn.outcome]),
  ).toEqual([
    ["old", 1, undefined],
    ["mid", 1, "stopped"],
    ["new", 1, undefined],
  ]);
});

it("keeps a stored copy of a running turn up to date with the live one", () => {
  const tool = (status: string, output: string) => ({
    id: `call-${status}`,
    at: 20,
    type: "tool",
    toolCallId: "c1",
    status,
    output,
  });
  const copy = {
    ...live("t", false, 10),
    items: [
      { id: "p", at: 10, type: "prompt", text: "Go" },
      tool("in_progress", ""),
      { id: "m", at: 30, type: "message", text: "Checking" },
    ],
  } as unknown as TranscriptTurn;
  const running = {
    ...live("t", true, 10),
    items: [
      tool("completed", "done"),
      { id: "seen", at: 30, type: "message", text: "Checking" },
      { id: "after", at: 40, type: "message", text: "Shipped" },
    ],
    outcome: "ended",
    endedAt: 50,
  } as unknown as TranscriptTurn;
  const [turn] = mergeTurns([running], [copy]);
  expect(turn).toMatchObject({ outcome: "ended", endedAt: 50, partial: false });
  expect(turn?.items.map((item) => item.id)).toEqual([
    "p",
    "call-completed",
    "m",
    "after",
  ]);
});

function reader(overrides: Partial<Record<keyof AgentClient, unknown>> = {}) {
  const client = {
    list: vi.fn(async () => [{ id: "agent-1", pubkey: "a".repeat(64) }]),
    sessions: vi.fn(async () => ({
      sessions: [
        session,
        { ...session, sessionId: "s2", threadRootId: "o".repeat(64) },
        { sessionId: "s3", channelId: "alpha", updatedAt: 0 },
        { sessionId: "s4", channelId: "beta", updatedAt: 0 },
      ],
      more: false,
    })),
    sessionMessages: vi.fn(async (id: string) => ({ id })),
    ...overrides,
  } as unknown as AgentClient;
  const login = {
    snapshot: () => ({
      status: "signed-in",
      account: { canUseRemoteAgents: true },
    }),
  } as unknown as BuilderlabSession;
  return { client, read: historyReader(client, login) };
}
const signal = new AbortController().signal;

it("reads the opened thread's session and its channel's shared one", async () => {
  const { client, read } = reader();
  const history = await read(
    "a".repeat(64),
    { channelId: "alpha", rootId: session.threadRootId as string },
    signal,
  );
  expect(client.sessions).toHaveBeenCalledWith("agent-1", signal);
  expect(history).toEqual({
    status: "loaded",
    more: false,
    sessions: [
      { session, response: { id: "s1" } },
      {
        session: { sessionId: "s3", channelId: "alpha", updatedAt: 0 },
        response: { id: "s3" },
      },
    ],
  });
});

it("reads the most recent sessions for all conversations, and says when more remain", async () => {
  const sessions = Array.from({ length: 7 }, (_, index) => ({
    ...session,
    sessionId: `s${index}`,
  }));
  const { client, read } = reader({
    sessions: vi.fn(async () => ({ sessions, more: false })),
  });
  const history = await read("a".repeat(64), {}, signal);
  expect(client.sessionMessages).toHaveBeenCalledTimes(5);
  expect(history).toMatchObject({ status: "loaded", more: true });
});

it("treats a Builderlab without stored sessions as live-only", async () => {
  const missing = () => Object.assign(new Error("missing"), { status: 404 });
  const { read } = reader({
    sessions: vi.fn(async () => {
      throw missing();
    }),
  });
  expect(await read("a".repeat(64), {}, signal)).toEqual({
    status: "unsupported",
  });
  const { read: ended } = reader({
    sessionMessages: vi.fn(async (id: string) => {
      if (id === "s1") throw missing();
      return { id };
    }),
  });
  const history = await ended("a".repeat(64), { channelId: "beta" }, signal);
  expect(history).toMatchObject({ sessions: [{ response: { id: "s4" } }] });
  const failed = await ended("a".repeat(64), {}, signal);
  expect(failed).toMatchObject({ sessions: { length: 3 } });
});

it("reads nothing for an agent outside the signed-in account", async () => {
  const { client, read } = reader({ list: vi.fn(async () => []) });
  expect(await read("a".repeat(64), {}, signal)).toEqual({
    status: "loaded",
    sessions: [],
    more: false,
  });
  expect(client.sessions).not.toHaveBeenCalled();
});

it("reads nothing before the owner signs in with remote agents", async () => {
  const client = { list: vi.fn() } as unknown as AgentClient;
  for (const snapshot of [
    { status: "signed-out" },
    { status: "signed-in", account: { canUseRemoteAgents: false } },
  ]) {
    const read = historyReader(client, {
      snapshot: () => snapshot,
    } as unknown as BuilderlabSession);
    expect(await read("a".repeat(64), {}, signal)).toEqual({
      status: "signed-out",
    });
  }
  expect(client.list).not.toHaveBeenCalled();
});
