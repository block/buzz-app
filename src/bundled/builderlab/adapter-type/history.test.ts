import { expect, it, vi } from "vitest";
import type { TranscriptTurn } from "../../../features/agents/activity-transcript";
import type { AgentClient, AgentSession } from "../agents/client";
import type { BuilderlabSession } from "../session";
import { listSessions, readSession, sessionTurns, TURN_LIMIT } from "./history";

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

const signal = new AbortController().signal;
const missing = () => Object.assign(new Error("missing"), { status: 404 });
const signedIn = {
  snapshot: () => ({
    status: "signed-in",
    account: { canUseRemoteAgents: true },
  }),
} as unknown as BuilderlabSession;
function client(overrides: Partial<Record<keyof AgentClient, unknown>> = {}) {
  return {
    list: vi.fn(async () => [{ id: "agent-1", pubkey: "a".repeat(64) }]),
    sessions: vi.fn(async () => ({ sessions: [session], more: true })),
    sessionMessages: vi.fn(async () => ({ turns: [], messages: [] })),
    ...overrides,
  } as unknown as AgentClient;
}

it("lists the signed-in owner's stored sessions of an agent", async () => {
  const reader = client();
  expect(await listSessions(reader, signedIn, "a".repeat(64), signal)).toEqual({
    status: "loaded",
    agentId: "agent-1",
    sessions: [session],
    more: true,
  });
  expect(reader.sessions).toHaveBeenCalledWith("agent-1", signal);
});

it("lists nothing for an agent outside the signed-in account", async () => {
  const reader = client({ list: vi.fn(async () => []) });
  expect(await listSessions(reader, signedIn, "a".repeat(64), signal)).toEqual({
    status: "loaded",
    sessions: [],
    more: false,
  });
  expect(reader.sessions).not.toHaveBeenCalled();
});

it("treats a Builderlab without stored sessions as unsupported", async () => {
  const reader = client({
    sessions: vi.fn(async () => {
      throw missing();
    }),
  });
  expect(await listSessions(reader, signedIn, "a".repeat(64), signal)).toEqual({
    status: "unsupported",
  });
});

it("lists nothing before the owner signs in with remote agents", async () => {
  const reader = client();
  for (const snapshot of [
    { status: "signed-out" },
    { status: "signed-in", account: { canUseRemoteAgents: false } },
  ])
    expect(
      await listSessions(
        reader,
        { snapshot: () => snapshot } as unknown as BuilderlabSession,
        "a".repeat(64),
        signal,
      ),
    ).toEqual({ status: "signed-out" });
  expect(reader.list).not.toHaveBeenCalled();
});

it("reads a session's latest turns, and says when earlier ones exist", async () => {
  const turns = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      turn_id: `t${index}`,
      created_at: index + 1,
    }));
  const read = async (response: unknown) =>
    readSession(
      client({ sessionMessages: vi.fn(async () => response) }),
      session,
      signal,
    );
  expect(await read({ turns: turns(2), messages: [] })).toMatchObject({
    turns: [{ turnId: "t0" }, { turnId: "t1" }],
    more: false,
  });
  expect(
    await read({ turns: turns(2), messages: [], has_earlier_turns: true }),
  ).toMatchObject({ more: true });
  const many = await read({ turns: turns(TURN_LIMIT + 1), messages: [] });
  expect(many?.turns).toHaveLength(TURN_LIMIT);
  expect(many?.turns[0]?.turnId).toBe("t1");
  expect(many?.more).toBe(true);
});

it("reads no transcript for a session Builderlab no longer has", async () => {
  const gone = client({
    sessionMessages: vi.fn(async () => {
      throw missing();
    }),
  });
  expect(await readSession(gone, session, signal)).toBeUndefined();
  const removed = client({
    sessionMessages: vi.fn(async () => ({ removal_state: 1 })),
  });
  expect(await readSession(removed, session, signal)).toBeUndefined();
});
