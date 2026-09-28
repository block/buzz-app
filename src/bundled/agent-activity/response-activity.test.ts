import { expect, it } from "vitest";
import { responseActivity } from "./response-activity";
const agent = "a".repeat(64),
  first = "b".repeat(64),
  second = "c".repeat(64);
const event = (
  seq: number,
  kind: string,
  payload: unknown = {},
  turnId = "turn",
  channelId = "alpha",
  sessionId: string | null = "S",
) => ({
  id: String(seq),
  agent,
  receivedAt: seq,
  kind,
  plaintext: JSON.stringify({
    seq,
    kind,
    payload,
    turnId,
    channelId,
    sessionId,
  }),
});
const start = (toolCallId: string, channel = "alpha", command?: string) => ({
  sessionUpdate: "tool_call",
  toolCallId,
  title: "buzz-dev-mcp__shell",
  status: "in_progress",
  rawInput: {
    command:
      command ??
      `printf '%s' 'Sample reply' | buzz messages send --channel ${channel} --content -`,
  },
});
const complete = (toolCallId: string, messageId: string) => ({
  sessionUpdate: "tool_call_update",
  toolCallId,
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
            event_id: messageId,
            message: "",
            mention_pubkeys: [],
          }),
        }),
      },
    },
  ],
});
const update = (seq: number, value: object, turn = "turn", channel = "alpha") =>
  event(
    seq,
    "acp_read",
    { method: "session/update", params: { sessionId: "S", update: value } },
    turn,
    channel,
  );
function fixture() {
  return [
    event(1, "turn_started", {}, "turn", "alpha", null),
    event(3, "session_resolved"),
    update(4, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Original work" },
    }),
    update(5, start("send-one")),
    update(6, complete("send-one", first)),
    update(8, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Correction work" },
    }),
    update(
      9,
      start(
        "send-two",
        "alpha",
        `python3 - <<'PY'\nprint('check the document')\nPY\ncount=$(wc -w < OUTBOX/REPORT.md | tr -d ' ')\ntest "$count" = 500\nprintf '%s' 'Correction' | buzz messages send --channel alpha --reply-to ${"d".repeat(64)} --content -`,
      ),
    ),
    update(10, complete("send-two", second)),
    event(11, "turn_completed"),
  ];
}
it("splits two sends in one turn without replaying the first interval under the correction", () => {
  const records = fixture();
  const original = responseActivity(records, agent, "alpha", first);
  const correction = responseActivity(records, agent, "alpha", second);
  expect(original.status).toBe("available");
  expect(correction.status).toBe("available");
  expect(original.records.map((r) => r.id)).toEqual(["1", "3", "4", "5", "6"]);
  expect(correction.records.map((r) => r.id)).toEqual(["8", "9", "10"]);
  expect(
    responseActivity([...records].reverse(), agent, "alpha", second),
  ).toEqual(correction);
  expect(responseActivity(records, "f".repeat(64), "alpha", first).status).toBe(
    "unavailable",
  );
  expect(responseActivity(records, agent, "beta", first).status).toBe(
    "unavailable",
  );
  expect(responseActivity(records, agent, "alpha", "e".repeat(64)).status).toBe(
    "unavailable",
  );
});
it("is unavailable for missing beginning, conflicting sequence, repeated starts, reused IDs, unmatched updates or sessions", () => {
  const records = fixture();
  const cases = [
    records.slice(1),
    [...records, event(3, "turn_liveness")],
    [...records, event(2, "turn_started")],
    [...records, update(7, start("send-one"))],
    [...records, update(7, complete("unknown", first))],
    records.map((r) =>
      r.id === "6"
        ? {
            ...r,
            plaintext: r.plaintext.replace(
              '"sessionId":"S","update"',
              '"sessionId":"OTHER","update"',
            ),
          }
        : r,
    ),
    records.map((r) =>
      r.id === "6"
        ? { ...r, plaintext: r.plaintext.replace('"seq":6', '"seq":null') }
        : r,
    ),
  ];
  for (const input of cases)
    expect(responseActivity(input, agent, "alpha", second).status).toBe(
      "unavailable",
    );
  expect(responseActivity([], agent, "alpha", second).status).toBe(
    "unavailable",
  );
});
it("rejects tools crossing a boundary, but permits concurrent tools wholly inside an interval", () => {
  const records = fixture();
  const tool = {
    sessionUpdate: "tool_call",
    toolCallId: "read",
    title: "Read file",
  };
  const done = {
    sessionUpdate: "tool_call_update",
    toolCallId: "read",
    status: "completed",
  };
  expect(
    responseActivity(
      [...records, update(2, tool), update(7, done)],
      agent,
      "alpha",
      second,
    ).status,
  ).toBe("unavailable");
  expect(
    responseActivity([...records, update(2, tool)], agent, "alpha", first)
      .status,
  ).toBe("unavailable");
  const fewer = records.filter((r) => r.id !== "3");
  expect(
    responseActivity(
      [...fewer, update(2, tool), update(3, done)],
      agent,
      "alpha",
      first,
    ).status,
  ).toBe("available");
});
it("does not select the newest of conflicting associations or inherit nested batch identity", () => {
  const records = fixture();
  const duplicate = records.slice(0, 5).map((r) => ({
    ...r,
    id: `other:${r.id}`,
    plaintext: r.plaintext.replace('"turnId":"turn"', '"turnId":"other"'),
  }));
  expect(
    responseActivity([...records, ...duplicate], agent, "alpha", first).status,
  ).toBe("unavailable");
  const batch = {
    ...records[0],
    id: "batch",
    agent,
    receivedAt: 0,
    kind: "batch",
    plaintext: JSON.stringify({
      kind: "batch",
      channelId: "alpha",
      payload: { events: records.map((r) => JSON.parse(r.plaintext)) },
    }),
  };
  expect(responseActivity([batch], agent, "alpha", first).status).toBe(
    "available",
  );
  batch.plaintext = JSON.stringify({
    kind: "batch",
    channelId: "alpha",
    payload: {
      events: [
        {
          kind: "batch",
          turnId: "turn",
          channelId: "alpha",
          payload: { events: records.map((r) => JSON.parse(r.plaintext)) },
        },
      ],
    },
  });
  expect(responseActivity([batch], agent, "alpha", first).status).toBe(
    "unavailable",
  );
});
it("respects another destination's send as an intervening boundary", () => {
  const records = fixture();
  records[3] = update(5, start("send-one", "beta"));
  const result = responseActivity(records, agent, "alpha", second);
  expect(result.records.map((r) => r.id)).toEqual(["8", "9", "10"]);
  // The command is display data; envelope author/channel and exact selected
  // message ID anchor association, never parsed CLI destination prose.
  expect(responseActivity(records, agent, "alpha", first).status).toBe(
    "available",
  );
});
it("rejects association-bearing tool updates that contradict the start", () => {
  const base = fixture();
  for (const patch of [
    { rawInput: start("send-one", "beta").rawInput },
    { title: "read_history" },
    {
      rawInput: {
        command:
          "buzz messages send --channel alpha --content hi; buzz messages send --channel beta --content other",
      },
    },
  ]) {
    const changed = base.map((row) =>
      row.id === "6"
        ? update(6, { ...complete("send-one", first), ...patch })
        : row,
    );
    expect(responseActivity(changed, agent, "alpha", first).status).toBe(
      "unavailable",
    );
  }
});
it("distinguishes absent scoped retention from unmatched retained activity", () => {
  expect(responseActivity([], agent, "alpha", first)).toMatchObject({
    status: "unavailable",
    reason: "not-retained",
  });
  expect(responseActivity(fixture(), agent, "beta", first)).toMatchObject({
    status: "unavailable",
    reason: "not-retained",
  });
  expect(responseActivity(fixture(), agent, "alpha", "f".repeat(64))).toEqual({
    status: "unavailable",
    records: [],
  });
});
it("isolates later malformed tool evidence without ignoring duplicated target receipts", () => {
  const rows = fixture();
  const original = responseActivity(rows, agent, "alpha", first);
  expect(
    responseActivity(
      [
        ...rows,
        update(20, {
          sessionUpdate: "tool_call_update",
          toolCallId: "unrelated",
          status: "completed",
        }),
      ],
      agent,
      "alpha",
      first,
    ),
  ).toEqual(original);
  expect(
    responseActivity(
      [...rows, update(20, complete("unrelated", first))],
      agent,
      "alpha",
      first,
    ).status,
  ).toBe("unavailable");
  expect(
    responseActivity(
      [
        ...rows,
        update(20, { ...complete("unrelated", first), status: "failed" }),
      ],
      agent,
      "alpha",
      first,
    ).status,
  ).toBe("unavailable");
});
it("a later malformed duplicate target claim cannot silently reuse an earlier boundary", () => {
  const malformed = complete("unknown", first);
  malformed.content[0] = {
    type: "content",
    content: {
      type: "text",
      text: JSON.stringify({
        exit_code: 0,
        timed_out: false,
        stdout_truncated: false,
        stdout: `{"accepted":true,"event_id":"${first}",`,
      }),
    },
  };
  expect(
    responseActivity(
      [...fixture(), update(20, malformed)],
      agent,
      "alpha",
      first,
    ).status,
  ).toBe("unavailable");
});

it("keeps coordination as a send boundary rather than treating it as turn completion", () => {
  const coordinated = fixture().map((row) => {
    if (row.id !== "6") return row;
    const raw = JSON.parse(row.plaintext);
    const block = raw.payload.params.update.content[0].content;
    const shell = JSON.parse(block.text);
    shell.stdout = JSON.stringify({
      ...JSON.parse(shell.stdout),
      audience: "agents",
    });
    block.text = JSON.stringify(shell);
    return { ...row, plaintext: JSON.stringify(raw) };
  });
  expect(responseActivity(coordinated, agent, "alpha", first).status).toBe(
    "available",
  );
  expect(
    responseActivity(coordinated, agent, "alpha", second).records.map(
      (row) => row.id,
    ),
  ).toEqual(["8", "9", "10"]);
});
