import type { RelaySession } from "../../src/features/relay/session";
import { createAgentLibrary } from "../../src/features/agents/library";
import { activityRecords } from "../../src/features/agents/activity-records";
import { createActivityHistory } from "../../src/features/agents/activity-history";

export const agent = "a".repeat(64),
  peer = "c".repeat(64),
  human = "b".repeat(64);
export const channel = "sample-design",
  response = "d".repeat(64);
export const scenarios = [
  [
    "working",
    "Working",
    "Fresh work with commentary and a running tool. Expand a tool to inspect its input.",
  ],
  [
    "complete",
    "Reply delivered",
    "A reported send boundary links the reply to its activity. Inspect the Response view.",
  ],
  [
    "ended",
    "Ended, no reply",
    "Work ended without evidence of a human-facing answer. Ended does not mean delivered.",
  ],
  [
    "failed",
    "Tool failure",
    "A failed tool and terminal error. Expand the failed tool to read its output.",
  ],
  [
    "recovered",
    "Failure → recovery",
    "A failed check followed by a successful retry and a response.",
  ],
  [
    "unknown",
    "Status unknown",
    "Retained work without fresh liveness. No working indicator should be inferred.",
  ],
  [
    "interrupted",
    "Feed interrupted",
    "Retained work with a disconnected feed. Retry live feed restores listening, not working evidence.",
  ],
  [
    "empty",
    "Waiting for activity",
    "Connected with no retained events for this identity.",
  ],
  ["connecting", "Connecting", "The feed has not connected yet."],
  [
    "disabled",
    "Activity disabled",
    "Capture is disabled; there is no current work evidence.",
  ],
  ["unavailable", "Unsupported host", "The host cannot supply live activity."],
  [
    "multi",
    "Two agents / namesakes",
    "Two exact identities share a display name. Switch identities in the Activity panel.",
  ],
  [
    "coordination",
    "Agent handoff",
    "Open progress, then explicitly reveal coordination. Human-facing answers stay outside the group.",
  ],
  [
    "long",
    "Long activity",
    "Twelve tool calls, long output and retention notice. Inline activity starts with a bounded preview.",
  ],
  [
    "missing",
    "Missing reply boundary",
    "A response has no matching retained send boundary. The Response view must not widen its scope.",
  ],
  [
    "saved",
    "Saved history",
    "Open Saved Activity. This is an in-memory archive stub; delete affects sample data only.",
  ],
  [
    "saved-error",
    "History read error",
    "Open Saved Activity, observe a read failure, then retry to recover.",
  ],
] as const;
export type Scenario = (typeof scenarios)[number][0];
type Snapshot = ReturnType<RelaySession["agentActivity"]["snapshot"]>;
const noop = () => () => {};
export function fixture(scenario: Scenario) {
  const records: Snapshot["records"][number][] = [];
  const turns: Snapshot["turns"][number][] = [];
  let serial = 0;
  const base = Date.now();
  function emit(kind: string, payload: unknown, key = agent) {
    const timestamp = base + serial;
    records.push({
      id: (++serial).toString(16).padStart(64, "0"),
      agent: key,
      createdAt: Math.floor(timestamp / 1000),
      receivedAt: timestamp,
      kind,
      channelIds: [channel],
      plaintext: JSON.stringify({
        kind,
        seq: serial,
        turnId: `turn-${key[0]}`,
        channelId: channel,
        sessionId: "sample",
        timestamp: new Date(timestamp).toISOString(),
        payload,
      }),
    });
  }
  const update = (value: object, key = agent) =>
    emit(
      "acp_read",
      {
        method: "session/update",
        params: { sessionId: "sample", update: value },
      },
      key,
    );
  function incoming(key: string, text: string, audience = "everyone") {
    emit("acp_write", {
      method: "session/prompt",
      params: {
        prompt: [
          {
            type: "text",
            text: `<buzz-event type="@mention">\nEvent ID: ${"e".repeat(64)}\nChannel: Design (#${channel})\nKind: 9\nFrom: Teammate (hex: ${key})\nTime: ${new Date(base).toISOString()}\nContent: ${text}\nTags: [["h","${channel}"],["audience","${audience}"]]\n</buzz-event>`,
          },
        ],
      },
    });
  }
  const empty = ["empty", "connecting", "disabled", "unavailable"].includes(
    scenario,
  );
  const ended = [
    "complete",
    "ended",
    "failed",
    "recovered",
    "coordination",
    "saved",
    "saved-error",
    "missing",
  ].includes(scenario);
  if (!empty) {
    emit("turn_started", { triggeringEventIds: ["e".repeat(64)] });
    incoming(human, "Check the composer retry path and tell me what you find.");
    update({
      sessionUpdate: "agent_thought_chunk",
      content: {
        type: "text",
        text: "I’ll inspect draft recovery, then check that retry preserves the selected agent.",
      },
    });
    for (let i = 0; i < (scenario === "long" ? 12 : 2); i++) {
      update({
        sessionUpdate: "tool_call",
        toolCallId: `read-${i}`,
        title: "buzz-dev-mcp__read_file",
        status: "completed",
        rawInput: { path: `src/composer/fixture-${i + 1}.tsx` },
        rawOutput:
          scenario === "long"
            ? "Sample source line. No real file was read.\n".repeat(60)
            : "The draft is preserved until the send succeeds.",
      });
    }
    const failed = scenario === "failed" || scenario === "recovered";
    update({
      sessionUpdate: "tool_call",
      toolCallId: "test",
      title: "Running composer tests",
      status: failed ? "failed" : ended ? "completed" : "in_progress",
      rawInput: { command: "pnpm vitest run MessageComposer.test.tsx" },
      rawOutput: failed
        ? "FAIL: recipient lost after rejected send"
        : "✓ retries with original draft\n✓ clears only after acceptance",
    });
    if (scenario === "recovered")
      update({
        sessionUpdate: "tool_call",
        toolCallId: "retry",
        title: "Rechecking composer tests",
        status: "completed",
        rawOutput: "2 tests passed after preserving the recipient.",
      });
    if (scenario === "coordination") {
      update({
        sessionUpdate: "tool_call",
        toolCallId: "delegate",
        title: "send_message",
        status: "completed",
        rawInput: {
          channel_id: channel,
          content: "Review agent, please verify the retry behavior.",
        },
        rawOutput: {
          accepted: true,
          event_id: "f".repeat(64),
          audience: "agents",
        },
      });
      incoming(
        peer,
        "Checked the retry path. The selected agent is preserved.",
        "agents",
      );
    }
    if (
      [
        "complete",
        "recovered",
        "coordination",
        "saved",
        "saved-error",
      ].includes(scenario)
    ) {
      update({
        sessionUpdate: "tool_call",
        toolCallId: "reply",
        title: "buzz-dev-mcp__shell",
        status: "in_progress",
        rawInput: {
          command: `buzz messages send --channel ${channel} --audience everyone --content 'The retry path now preserves the selected agent.'`,
        },
      });
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "reply",
        status: "completed",
        rawOutput: { isError: false },
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: JSON.stringify({
                exit_code: 0,
                timed_out: false,
                stdout_truncated: false,
                stdout: JSON.stringify({
                  accepted: true,
                  event_id: response,
                  message:
                    "The retry path now preserves the selected agent. Both checks passed.",
                  mention_pubkeys: [],
                  audience: "everyone",
                }),
              }),
            },
          },
        ],
      });
    }
    if (ended)
      emit(
        scenario === "failed" ? "turn_error" : "turn_completed",
        scenario === "failed" ? { error: "Composer checks failed" } : {},
      );
    turns.push({
      agent,
      turnId: "turn-a",
      channelId: channel,
      timestamp: base,
      state: ended
        ? "ended"
        : ["unknown", "interrupted"].includes(scenario)
          ? "unknown"
          : "working",
    });
    if (scenario === "multi") {
      emit("turn_started", {}, peer);
      update(
        {
          sessionUpdate: "tool_call",
          toolCallId: "review",
          title: "Reviewing the fix",
          status: "in_progress",
          rawInput: { path: "MessageComposer.tsx" },
        },
        peer,
      );
      turns.push({
        agent: peer,
        turnId: "turn-c",
        channelId: channel,
        timestamp: base,
        state: "working",
      });
    }
  }
  let snapshot: Snapshot = {
    status:
      scenario === "interrupted"
        ? "interrupted"
        : scenario === "connecting" ||
            scenario === "disabled" ||
            scenario === "unavailable"
          ? scenario
          : "listening",
    records,
    turns,
    typing: [],
    trimmed: scenario === "long" ? 42 : 0,
  };
  const listeners = new Set<() => void>();
  const profiles = new Map([
    [agent, { name: "Rivet" }],
    [peer, { name: scenario === "multi" ? "Rivet" : "Review agent" }],
    [human, { name: "Alex" }],
  ]);
  const channels = {
    status: "ready",
    channels: [{ id: channel, name: "Design" }],
  };
  let archived = activityRecords(records, agent, channel);
  let failRead = scenario === "saved-error";
  const history = createActivityHistory(
    ["saved", "saved-error"].includes(scenario)
      ? {
          async read() {
            if (failRead) {
              failRead = false;
              throw new Error("Sample archive read failed. Retry to recover.");
            }
            return {
              records: archived,
              more: false,
              before: null,
              trimmed: false,
              epoch: 1,
              revision: 1,
              channels: [channel],
            };
          },
          async delete() {
            archived = [];
          },
        }
      : undefined,
    () => true,
    () => {},
  );
  if (scenario.startsWith("saved"))
    snapshot = { ...snapshot, records: [], turns: [] };
  const session = {
    viewer: human,
    agentChoices: createAgentLibrary(undefined).queries,
    agentActivity: {
      snapshot: () => snapshot,
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
      activate: noop,
    },
    profiles: { snapshot: () => profiles, subscribe: noop },
    channels: { list: () => channels, subscribeList: noop },
    activityHistory: history.queries,
    live: {
      retry: () => {
        snapshot = { ...snapshot, status: "listening" };
        for (const fn of listeners) fn();
      },
    },
    media: (url: string) => url,
  } as unknown as RelaySession;
  return { session, profiles, dispose: () => history.dispose() };
}
