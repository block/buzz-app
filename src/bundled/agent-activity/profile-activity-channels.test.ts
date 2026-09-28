import { expect, it } from "vitest";
import type { ActivityRecord } from "../../features/agents/activity-records";
import type { ActivityTurn } from "../../features/agents/activity";
import {
  chooseProfileActivityChannel,
  profileActivityChannels,
  resolveProfileActivityChannel,
} from "./profile-activity-channels";
const agent = "a".repeat(64);
const turn = (
  channelId: string,
  state: ActivityTurn["state"] = "working",
): ActivityTurn => ({
  agent,
  channelId,
  turnId: channelId,
  state,
  timestamp: 0,
});
const record = (
  id: string,
  value: unknown,
  author = agent,
): ActivityRecord => ({
  id,
  envelopeId: id,
  agent: author,
  kind: "acp_read",
  receivedAt: 0,
  plaintext: JSON.stringify(value),
});
const read = (channelId: string, id = channelId) =>
  record(id, {
    kind: "acp_read",
    channelId,
    turnId: channelId,
    payload: {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: id,
          title: "buzz-dev-mcp__read_file",
          status: "completed",
        },
      },
    },
  });

it("matches old live-channel membership and lexical initial preference, not recency", () => {
  const model = profileActivityChannels(
    [read("retained")],
    [turn("z"), turn("a"), { ...turn("other"), agent: "other" }],
    agent,
  );
  expect(model).toEqual({ channels: ["z", "a"], preferred: "a" });
  expect(
    resolveProfileActivityChannel(model.channels, "", model.preferred),
  ).toBe("a");
  expect(
    resolveProfileActivityChannel(model.channels, "z", model.preferred),
  ).toBe("z");
});

it("matches retained transcript precedence and exact child scope without batch inheritance", () => {
  const model = profileActivityChannels(
    [
      read("z"),
      read("a"),
      record("batch", {
        kind: "batch",
        channelId: "not-inherited",
        payload: {
          events: [
            { kind: "turn_liveness", channelId: "b" },
            { kind: "session_resolved" },
          ],
        },
      }),
      read("foreign", "foreign"),
    ].map((item) =>
      item.id === "foreign" ? { ...item, agent: "foreign" } : item,
    ),
    [turn("z", "ended"), turn("a", "unknown")],
    agent,
  );
  expect(model).toEqual({ channels: ["a", "b", "z"], preferred: "a" });
  const onlyRaw = profileActivityChannels(
    [
      record("raw", {
        kind: "batch",
        channelId: "not-inherited",
        payload: {
          events: [
            { kind: "turn_liveness", channelId: "z" },
            { kind: "turn_liveness", channelId: "a" },
          ],
        },
      }),
    ],
    [],
    agent,
  );
  expect(onlyRaw).toEqual({ channels: ["a", "z"], preferred: "a" });
});

it("does not reorder old transcript insertion preference for a later folded tool update", () => {
  const update = record("update", {
    kind: "acp_read",
    channelId: "z",
    turnId: "z",
    payload: {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "z",
          status: "completed",
        },
      },
    },
  });
  expect(
    profileActivityChannels([read("z"), read("a"), update], [], agent)
      .preferred,
  ).toBe("a");
});

it("preserves selection while available and follows old preferred/first/null fallback when removed", () => {
  expect(resolveProfileActivityChannel(["a", "z"], "z", "a")).toBe("z");
  expect(resolveProfileActivityChannel(["a", "b"], "z", "b")).toBe("b");
  expect(resolveProfileActivityChannel(["a", "b"], "z", "missing")).toBe("a");
  expect(resolveProfileActivityChannel([], "z", "missing")).toBe("");
  expect(
    profileActivityChannels(
      [
        record("bad", {
          kind: "batch",
          channelId: "not-inherited",
          payload: { events: [{ kind: "session_resolved" }] },
        }),
      ],
      [],
      agent,
    ),
  ).toEqual({ channels: [], preferred: "" });
});

it("matches the two-channel selected-dot advance and ordinary multi-channel selection", () => {
  expect(chooseProfileActivityChannel(["a", "b"], "a", "a")).toBe("b");
  expect(chooseProfileActivityChannel(["a", "b"], "a", "b")).toBe("b");
  expect(chooseProfileActivityChannel(["a", "b", "c"], "a", "a")).toBe("a");
  expect(chooseProfileActivityChannel(["a", "b", "c"], "a", "c")).toBe("c");
});

it("preserves old start/session transcript preference without promoting terminal or folded repeats", () => {
  const start = record("start", {
    kind: "turn_started",
    channelId: "b",
    turnId: "B",
    seq: 1,
  });
  const ready = record("ready", {
    kind: "session_resolved",
    channelId: "c",
    turnId: "C",
    seq: 1,
  });
  expect(profileActivityChannels([read("a"), start], [], agent).preferred).toBe(
    "b",
  );
  expect(
    profileActivityChannels([read("a"), start, ready], [], agent).preferred,
  ).toBe("c");
  const repeated = { ...start, id: "repeated", envelopeId: "repeated" };
  expect(
    profileActivityChannels([start, read("a"), repeated], [], agent).preferred,
  ).toBe("a");
  const end = record("end", {
    kind: "turn_completed",
    channelId: "b",
    turnId: "B",
    seq: 2,
  });
  expect(profileActivityChannels([read("a"), end], [], agent).preferred).toBe(
    "a",
  );
});
