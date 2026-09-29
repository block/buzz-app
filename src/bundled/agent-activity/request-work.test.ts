import { expect, it } from "vitest";
import { requestWork, elapsedWork } from "./request-work";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelMessage } from "../../features/relay/contracts";
type Snapshot = ReturnType<RelaySession["agentActivity"]["snapshot"]>;
const root = "1".repeat(64),
  next = "2".repeat(64),
  handoff = "3".repeat(64),
  viewer = "a".repeat(64),
  A = "b".repeat(64),
  B = "c".repeat(64);
const message = (id: string, authorId = viewer): ChannelMessage => ({
  id,
  authorId,
  channelId: "c",
  createdAt: 1,
  content: "sample",
  mentions: [A, B],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
  ...(id !== root ? { threadRootId: root } : {}),
});
function fixture() {
  const snapshot: Snapshot = {
    status: "listening",
    records: [],
    turns: [],
    typing: [],
    trimmed: 0,
  };
  let n = 0;
  const records = [...snapshot.records],
    turns = [...snapshot.turns];
  const emit = (
    agent: string,
    turnId: string,
    seq: number,
    kind: string,
    payload: unknown,
    time = 1000,
  ) =>
    records.push({
      id: String(++n),
      agent,
      kind,
      createdAt: Math.floor(time / 1000),
      receivedAt: time,
      channelIds: ["c"],
      plaintext: JSON.stringify({
        kind,
        channelId: "c",
        sessionId: "S",
        turnId,
        seq,
        timestamp: new Date(time).toISOString(),
        payload,
      }),
    });
  const start = (
    agent: string,
    id: string,
    triggers: string[],
    time = 1000,
  ) => {
    emit(agent, id, 1, "turn_started", { triggeringEventIds: triggers }, time);
    turns.push({
      agent,
      turnId: id,
      channelId: "c",
      timestamp: time,
      state: "working",
    });
  };
  const end = (agent: string, id: string, time = 241000) => {
    emit(agent, id, 4, "turn_completed", {}, time);
    const index = turns.findIndex((t) => t.agent === agent && t.turnId === id);
    turns[index] = {
      agent,
      turnId: id,
      channelId: "c",
      timestamp: time,
      state: "ended",
    };
  };
  const send = (agent: string, turnId: string, id: string) => {
    emit(agent, turnId, 2, "acp_read", {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "send",
          title: "buzz-dev-mcp__shell",
          status: "in_progress",
          rawInput: { command: "buzz messages send" },
        },
      },
    });
    emit(agent, turnId, 3, "acp_read", {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "send",
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
                    event_id: id,
                    message: "",
                    mention_pubkeys: [],
                    audience: "agents",
                  }),
                }),
              },
            },
          ],
        },
      },
    });
  };
  return {
    snapshot: () => ({ ...snapshot, records, turns }),
    start,
    end,
    send,
    emit,
    records,
  };
}
it("links an explicit cross-agent handoff to its request regardless of arrival order; another request stays separate", () => {
  const f = fixture();
  f.start(B, "two", [handoff], 61000);
  f.end(B, "two");
  f.start(A, "one", [root]);
  f.send(A, "one", handoff);
  f.end(A, "one", 31000);
  f.start(A, "followup", [next], 300000);
  const work = requestWork(
    f.snapshot(),
    [message(root), message(next), message(handoff, A)],
    "c",
    root,
    viewer,
  );
  expect(work[0]?.agents.map((a) => a.agent)).toEqual([A, B]);
  expect(work[0]?.elapsed).toBe(240000);
  expect(work[0]?.state).toBe("ended");
  expect(work[1]?.agents.map((a) => a.agent)).toEqual([A]);
  expect(work[1]?.state).toBe("working");
  expect(elapsedWork(work[0]?.elapsed ?? 0)).toBe("4 minutes");
});
it("never guesses by signed parent, names, prose, or partial trigger overlap", () => {
  for (const triggers of [[root, next], [root, "f".repeat(64)], [handoff]]) {
    const f = fixture();
    f.start(A, "one", triggers);
    f.end(A, "one");
    const rows = [
      message(root),
      message(next),
      { ...message(handoff, B), replyParentId: root },
    ];
    const work = requestWork(f.snapshot(), rows, "c", root, viewer);
    expect(work.every((group) => group.agents.length === 0)).toBe(true);
    expect(work.every((group) => group.elapsed === undefined)).toBe(true);
  }
});
it("requires one unique send report and matching signed author for propagation", () => {
  for (const conflict of ["author", "duplicate"]) {
    const f = fixture();
    f.start(A, "one", [root]);
    f.send(A, "one", handoff);
    f.end(A, "one");
    f.start(B, "two", [handoff]);
    if (conflict === "duplicate") {
      f.start(A, "again", [root]);
      f.send(A, "again", handoff);
    }
    const work = requestWork(
      f.snapshot(),
      [message(root), message(handoff, conflict === "author" ? B : A)],
      "c",
      root,
      viewer,
    )[0];
    expect(work?.agents.some((a) => a.agent === B)).toBe(false);
    expect(work?.agents.some((a) => a.agent === A)).toBe(true);
  }
});
it("omits duration for trimmed, missing, malformed or clock-inconsistent lifecycle evidence", () => {
  for (const mode of [
    "trimmed",
    "no-turn",
    "backwards",
    "future",
    "duplicate-start",
  ]) {
    const f = fixture();
    f.start(A, "one", [root], 100000);
    f.end(A, "one", mode === "backwards" ? 90000 : 150000);
    if (mode === "duplicate-start")
      f.emit(A, "one", 5, "turn_started", { triggeringEventIds: [root] });
    if (mode === "future") {
      const row = f.records[0];
      if (row) f.records[0] = { ...row, receivedAt: 0 };
    }
    const snapshot = f.snapshot();
    const work = requestWork(
      {
        ...snapshot,
        trimmed: mode === "trimmed" ? 1 : 0,
        turns: mode === "no-turn" ? [] : snapshot.turns,
      },
      [message(root)],
      "c",
      root,
      viewer,
    )[0];
    expect(work?.elapsed).toBeUndefined();
  }
});
it("isolates exact identities, channels, roots, viewer and resets", () => {
  const f = fixture();
  f.start(A, "same", [root]);
  f.start(B, "same", [root]);
  f.end(A, "same");
  expect(
    requestWork(f.snapshot(), [message(root)], "c", root, viewer)[0]?.agents,
  ).toHaveLength(2);
  expect(
    requestWork(f.snapshot(), [message(root)], "other", root, viewer),
  ).toEqual([]);
  expect(requestWork(f.snapshot(), [message(root)], "c", next, viewer)).toEqual(
    [],
  );
  expect(
    requestWork(f.snapshot(), [message(root)], "c", root, "other"),
  ).toEqual([]);
  expect(
    requestWork(
      { ...f.snapshot(), records: [], turns: [] },
      [message(root)],
      "c",
      root,
      viewer,
    )[0]?.agents,
  ).toEqual([]);
});

it("does not compare producer clocks or let another request's malformed turns erase a valid duration", () => {
  const f = fixture();
  f.start(A, "good", [root]);
  f.end(A, "good", 241000);
  f.start(B, "bad", [next]);
  f.emit(B, "bad", 5, "turn_started", { triggeringEventIds: [next] });
  let work = requestWork(
    f.snapshot(),
    [message(root), message(next)],
    "c",
    root,
    viewer,
  );
  expect(work[0]?.elapsed).toBe(240000);
  expect(work[1]?.uncertain).toBe(true);
  // Shift only producer timestamps backward; duration is from one local capture clock.
  for (let i = 0; i < f.records.length; i++) {
    const row = f.records[i];
    if (!row || row.agent !== A) continue;
    const value = JSON.parse(row.plaintext);
    value.timestamp = new Date(
      Date.parse(value.timestamp) + 900000,
    ).toISOString();
    f.records[i] = {
      ...row,
      receivedAt: row.receivedAt + 900000,
      plaintext: JSON.stringify(value),
    };
  }
  work = requestWork(
    f.snapshot(),
    [message(root), message(next)],
    "c",
    root,
    viewer,
  );
  expect(work[0]?.elapsed).toBe(240000);
});

it("uses one local clock for multi-agent elapsed even when a producer clock is slow", () => {
  const f = fixture();
  f.start(A, "one", [root], 1000000);
  f.end(A, "one", 1060000);
  f.start(B, "two", [root], 1060000);
  f.end(B, "two", 1240000);
  for (let i = 0; i < f.records.length; i++) {
    const row = f.records[i];
    if (!row || row.agent !== B) continue;
    const raw = JSON.parse(row.plaintext);
    raw.timestamp = new Date(Date.parse(raw.timestamp) - 900000).toISOString();
    f.records[i] = { ...row, plaintext: JSON.stringify(raw) };
  }
  expect(
    requestWork(f.snapshot(), [message(root)], "c", root, viewer)[0]?.elapsed,
  ).toBe(240000);
});
it("unresolved circular handoffs never create a new scope", () => {
  const f = fixture();
  const reverse = "4".repeat(64);
  f.start(A, "one", [reverse]);
  f.send(A, "one", handoff);
  f.start(B, "two", [handoff]);
  f.send(B, "two", reverse);
  expect(
    requestWork(
      f.snapshot(),
      [message(root), message(handoff, A), message(reverse, B)],
      "c",
      root,
      viewer,
    )[0]?.agents,
  ).toEqual([]);
});
it("exposes only strictly reported same-author replies for each independent request and per-agent local duration", () => {
  const f = fixture(),
    answer = "4".repeat(64),
    later = "5".repeat(64);
  f.start(A, "first", [root]);
  f.send(A, "first", answer);
  f.end(A, "first", 61000);
  f.start(B, "second", [root], 1000);
  f.end(B, "second", 121000);
  f.start(A, "followup", [next]);
  f.send(A, "followup", later);
  f.end(A, "followup", 31000);
  const rows = [
    message(root),
    message(next),
    message(answer, A),
    message(later, A),
    message("6".repeat(64), B),
  ];
  const work = requestWork(f.snapshot(), rows, "c", root, viewer);
  expect(work[0]?.agents[0]?.responseIds).toEqual([answer]);
  expect(work[0]?.agents[0]?.elapsed).toBe(60000);
  expect(work[0]?.agents[1]?.responseIds).toEqual([]);
  expect(work[1]?.agents[0]?.responseIds).toEqual([later]);
  const mismatch = requestWork(
    f.snapshot(),
    rows.map((row) => (row.id === answer ? { ...row, authorId: B } : row)),
    "c",
    root,
    viewer,
  );
  expect(mismatch[0]?.agents[0]?.responseIds).toEqual([]);
});

it("propagates a multi-send handoff and attaches its public answer without merging another request", () => {
  const f = fixture(),
    answer = "4".repeat(64);
  f.start(A, "producer", [root]);
  f.send(A, "producer", handoff);
  const index = f.records.findIndex(
    (row) => JSON.parse(row.plaintext).seq === 3,
  );
  const record = f.records[index];
  if (!record) throw Error("fixture requires completion");
  const raw = JSON.parse(record.plaintext);
  const block = raw.payload.params.update.content[0].content;
  const output = JSON.parse(block.text),
    receipt = JSON.parse(output.stdout);
  output.stdout += `\n${JSON.stringify({ ...receipt, event_id: answer, audience: "everyone" })}`;
  block.text = JSON.stringify(output);
  f.records[index] = { ...record, plaintext: JSON.stringify(raw) };
  f.end(A, "producer");
  f.start(B, "recipient", [handoff]);
  const rows = [
    message(root),
    message(next),
    message(handoff, A),
    message(answer, A),
  ];
  const work = requestWork(f.snapshot(), rows, "c", root, viewer);
  expect(work[0]?.agents.map((agent) => agent.agent)).toEqual([A, B]);
  expect(work[0]?.agents[0]?.responseIds).toEqual([handoff, answer]);
  expect(work[1]?.agents).toEqual([]);
  // A rejected sibling makes the entire multi-send output unusable for lineage.
  output.stdout = `${JSON.stringify(receipt)}\n${JSON.stringify({ ...receipt, event_id: answer, accepted: false })}`;
  block.text = JSON.stringify(output);
  f.records[index] = { ...record, plaintext: JSON.stringify(raw) };
  const rejected = requestWork(f.snapshot(), rows, "c", root, viewer);
  expect(rejected[0]?.agents[0]?.responseIds).toEqual([]);
  expect(rejected[0]?.agents.map((agent) => agent.agent)).toEqual([A]);
});
