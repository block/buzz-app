import { expect, it } from "vitest";
import { activityRecords } from "../../features/agents/activity-records";
import { activityTranscript, TRANSCRIPT_EVENT_LIMIT } from "./transcript";
const event = (
  kind: string,
  payload: unknown,
  turnId: string | null = "turn",
  channelId: string | null = "alpha",
) => ({ kind, payload, turnId, channelId, sessionId: "S" });
const update = (sessionUpdate: string, extra = {}) =>
  event("acp_read", {
    method: "session/update",
    params: { sessionId: "S", update: { sessionUpdate, ...extra } },
  });
const records = (values: unknown[], agent = "agent") =>
  activityRecords(
    values.map((value, i) => ({
      id: String(i),
      agent,
      kind: "event",
      receivedAt: i,
      plaintext: JSON.stringify(value),
    })),
    agent,
  );

it("groups exact agent/channel/turn identities and never inherits batch context", () => {
  const raw = records([
    {
      kind: "batch",
      channelId: "alpha",
      turnId: "parent",
      payload: {
        events: [
          event("turn_started", {}, "same", "alpha"),
          event("turn_started", {}, "same", "beta"),
          event("acp_read", {}, null, null),
        ],
      },
    },
  ]);
  const result = activityTranscript(raw);
  expect(result.groups.map((g) => [g.channelId, g.turnId])).toEqual([
    ["alpha", "same"],
    ["beta", "same"],
    [null, null],
  ]);
  const filtered = activityRecords(raw, "agent", "alpha");
  expect(activityTranscript(filtered).groups).toHaveLength(1);
  expect(
    activityTranscript([
      ...records([update("tool_call", { toolCallId: "one", title: "First" })]),
      ...records(
        [update("tool_call", { toolCallId: "one", title: "Second" })],
        "other",
      ),
    ]).groups,
  ).toHaveLength(2);
});
it("renders prompts as inert text, coalesces contiguous chunks, and keeps separate prompt boundaries", () => {
  const result = activityTranscript(
    records([
      event("acp_write", {
        method: "session/prompt",
        params: {
          prompt: [{ type: "text", text: "<script>literal</script>" }],
        },
      }),
      update("agent_message_chunk", {
        content: { type: "text", text: "Hello " },
      }),
      update("agent_message_chunk", {
        content: { type: "text", text: "world" },
      }),
      event("acp_write", {
        method: "_session/steering",
        params: { prompt: [{ type: "text", text: "Follow up" }] },
      }),
      update("agent_message_chunk", {
        content: { type: "text", text: "Second response" },
      }),
    ]),
  );
  const entries = result.groups[0]?.entries ?? [];
  expect(entries.map((e) => [e.title, e.body])).toEqual([
    ["Request context", "<script>literal</script>"],
    ["Response", "Hello world"],
    ["Follow-up context", "Follow up"],
    ["Response", "Second response"],
  ]);
  expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
  expect(entries[1]?.sourceIds).toEqual(["1", "2"]);
});
it("folds tool snapshots only within a turn/session and retains terminal status through delayed starts", () => {
  const start = update("tool_call", {
    toolCallId: "tool",
    title: "Read README.md",
    status: "in_progress",
    rawInput: { path: "README.md" },
  });
  const result = activityTranscript(
    records([
      start,
      update("tool_call_update", {
        toolCallId: "tool",
        status: "completed",
        rawOutput: { text: "first" },
      }),
      update("tool_call_update", { toolCallId: "tool", status: "in_progress" }),
      { ...start, turnId: "different" },
      event("acp_read", {
        method: "session/update",
        params: {
          sessionId: "other",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool",
            title: "Other session",
          },
        },
      }),
    ]),
  );
  expect(result.groups).toHaveLength(2);
  const tools = result.groups[0]?.entries ?? [];
  expect(tools).toHaveLength(2);
  expect(tools[0]).toMatchObject({
    title: "Read README.md",
    status: "completed",
    sourceIds: ["0", "1", "2"],
    input: '{\n  "path": "README.md"\n}',
    output: '{\n  "text": "first"\n}',
  });
  expect(tools[1]?.title).toBe("Other session");
});
it("keeps update-only, failed, unknown, nontext and malformed observations inspectable", () => {
  const result = activityTranscript(
    records([
      update("tool_call_update", {
        toolCallId: "missing-start",
        status: "failed",
        content: [
          {
            type: "content",
            content: { type: "text", text: "Permission denied" },
          },
        ],
      }),
      update("agent_thought_chunk", {
        content: { type: "image", data: "ignored" },
      }),
      update("plan", {
        entries: [
          { status: "completed", content: "Read file" },
          { status: "pending", content: "Run tests" },
          null,
        ],
      }),
      event("acp_read", { text: "not a file read" }),
      event("new-event", "literal"),
      event("turn_error", {}),
      event("turn_completed", {}),
    ]),
  );
  expect(result.groups[0]?.entries.map((e) => e.title)).toEqual([
    "Tool call",
    "Thinking",
    "Plan",
    "Other activity",
    "Other activity",
    "Turn error",
    "Turn ended",
  ]);
  expect(result.groups[0]?.entries[0]).toMatchObject({
    status: "failed",
    output: "Permission denied",
  });
  expect(result.groups[0]?.entries[2]?.body).toBe("✓ Read file\n• Run tests");
  expect(
    activityTranscript([
      {
        id: "broken",
        envelopeId: "broken",
        agent: "agent",
        receivedAt: 0,
        kind: "unknown",
        plaintext: "broken",
      },
    ]).groups,
  ).toEqual([]);
});
it("does not merge tools without IDs or chunks with different message IDs", () => {
  const result = activityTranscript(
    records([
      update("tool_call", { title: "One" }),
      update("tool_call", { title: "Two" }),
      update("agent_message_chunk", {
        messageId: "a",
        content: { type: "text", text: "A" },
      }),
      update("agent_message_chunk", {
        messageId: "b",
        content: { type: "text", text: "B" },
      }),
    ]),
  );
  expect(result.groups[0]?.entries).toHaveLength(4);
});
it("bounds a large batch and recomputes from retained evidence without resurrecting removed details", () => {
  const values = Array.from({ length: TRANSCRIPT_EVENT_LIMIT + 5 }, (_, i) =>
    event("acp_read", { text: String(i) }, String(i)),
  );
  const raw = records([{ kind: "batch", payload: { events: values } }]);
  const before = JSON.stringify(raw);
  const result = activityTranscript(raw);
  expect(result.omitted).toBe(5);
  expect(result.groups).toHaveLength(TRANSCRIPT_EVENT_LIMIT);
  expect(result.groups[0]?.turnId).toBe("5");
  expect(JSON.stringify(raw)).toBe(before);
  expect(activityTranscript([])).toMatchObject({ groups: [], omitted: 0 });
  const onlyUpdate = activityTranscript(
    records([
      update("tool_call_update", {
        toolCallId: "missing",
        status: "completed",
      }),
    ]),
  );
  expect(onlyUpdate.groups[0]?.entries[0]?.title).toBe("Tool call");
});
it("does not unfold nested batches after exact-channel projection", () => {
  const input = records([
    {
      kind: "batch",
      payload: {
        events: [
          {
            kind: "batch",
            channelId: "alpha",
            payload: { events: [event("acp_read", {}, "secret", "beta")] },
          },
        ],
      },
    },
  ]);
  const scoped = activityRecords(input, "agent", "alpha");
  expect(activityTranscript(scoped).groups.map((g) => g.channelId)).toEqual([
    "alpha",
  ]);
});
it("respects ACP session identity and intervening tool updates when joining chunks", () => {
  const chunk = (body: string, session = "S") =>
    event("acp_read", {
      method: "session/update",
      params: {
        sessionId: session,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: body },
        },
      },
    });
  const result = activityTranscript(
    records([
      update("tool_call", { toolCallId: "tool", title: "Read file" }),
      chunk("A"),
      update("tool_call_update", { toolCallId: "tool", status: "completed" }),
      chunk("B"),
      chunk("C", "other"),
    ]),
  );
  expect(
    result.groups[0]?.entries
      .filter((e) => e.kind === "message")
      .map((e) => e.body),
  ).toEqual(["A", "B", "C"]);
});
it("distinguishes omitted output from an explicitly cleared snapshot", () => {
  const input = [
    update("tool_call", { toolCallId: "tool", rawOutput: "Old output" }),
    update("tool_call_update", { toolCallId: "tool", status: "in_progress" }),
  ];
  expect(
    activityTranscript(records(input)).groups[0]?.entries[0]?.output,
  ).toContain("Old output");
  input.push(update("tool_call_update", { toolCallId: "tool", content: [] }));
  expect(activityTranscript(records(input)).groups[0]?.entries[0]?.output).toBe(
    "",
  );
});
it("classifies setup by direction, pairs only captured control responses, and never hides permission decisions", () => {
  const result = activityTranscript(
    records([
      event("acp_write", { id: 1, method: "initialize", params: {} }),
      event("acp_read", { id: 1, result: {} }),
      event("acp_read", {
        id: 2,
        method: "session/request_permission",
        params: {},
      }),
      event("acp_write", {
        id: 2,
        result: { outcome: { outcome: "selected", optionId: "allow" } },
      }),
      event("acp_write", { id: 3, method: "session/new", params: {} }),
      event("acp_read", { id: 3, error: { message: "no session" } }),
      event("acp_read", { id: 4, result: {} }),
      update("session_info_update", {}),
      event("acp_read", {
        method: "_goose/unstable/session/update",
        params: { update: { sessionUpdate: "usage_update", used: 1 } },
      }),
      event("acp_read", { id: 5, method: "initialize" }),
      update("future_update", {}),
    ]),
  );
  expect(
    result.groups[0]?.entries.map((e) => [e.title, !!e.diagnostic]),
  ).toEqual([
    ["Initialize agent", true],
    ["Session setup response", true],
    ["Permission requested", false],
    ["Permission response", false],
    ["Prepare session", true],
    ["Session setup response error", false],
    ["Other activity", false],
    ["Session update", true],
    ["Usage update", true],
    ["Other activity", false],
    ["future_update", false],
  ]);
});
it("raw source uses exact projected children and retains known and unknown evidence", () => {
  const raw = records([
    {
      kind: "batch",
      payload: {
        events: [
          event("new-event", "alpha secret", "T", "alpha"),
          event("new-event", "beta secret", "T", "beta"),
        ],
      },
    },
  ]);
  const general = activityTranscript(raw);
  const first = general.groups[0]?.entries[0]?.sourceIds[0];
  expect(general.source(first ?? "")?.plaintext).toContain("alpha secret");
  expect(general.source(first ?? "")?.plaintext).not.toContain("beta secret");
  const scoped = activityTranscript(activityRecords(raw, "agent", "alpha"));
  expect(
    scoped.source(scoped.groups[0]?.entries[0]?.sourceIds[0] ?? "")?.plaintext,
  ).not.toContain("beta secret");
  expect(scoped.source("evicted")).toBeUndefined();
});
it("pairs unassigned setup RPCs by stable scope without pairing across sessions", () => {
  const req = event("acp_write", { id: 1, method: "initialize" }, null);
  const res = event("acp_read", { id: 1, result: {} }, null);
  const result = activityTranscript(
    records([req, { ...res, sessionId: "other" }, res]),
  );
  expect(
    result.groups.flatMap((g) =>
      g.entries.map((e) => [e.title, !!e.diagnostic]),
    ),
  ).toEqual([
    ["Initialize agent", true],
    ["Other activity", false],
    ["Session setup response", true],
  ]);
});
it("preserves a known tool identity when the producer updates its display title", () => {
  const result = activityTranscript(
    records([
      update("tool_call", {
        toolCallId: "shell",
        title: "buzz-dev-mcp__shell",
        rawInput: { command: "check" },
      }),
      update("tool_call_update", {
        toolCallId: "shell",
        title: "Finished checking",
        status: "completed",
      }),
    ]),
  );
  expect(result.groups[0]?.entries[0]).toMatchObject({
    toolName: "buzz-dev-mcp__shell",
    title: "Finished checking",
  });
});
it("folds only exact recognized allowed permissions into details, with both raw halves retained", () => {
  const request = (options: unknown) =>
    event("acp_read", {
      id: 7,
      method: "session/request_permission",
      params: { options },
    });
  const response = (outcome: unknown) =>
    event("acp_write", { id: 7, result: { outcome } });
  const option = { optionId: "selected-option", kind: "allow_once" };
  const source = [
    request([option]),
    response({ outcome: "selected", optionId: "selected-option" }),
  ];
  const allowed = activityTranscript(records(source));
  expect(allowed.groups[0]?.entries).toHaveLength(1);
  expect(allowed.groups[0]?.entries[0]).toMatchObject({
    title: "Permission allowed",
    diagnostic: true,
    sourceIds: ["0", "1"],
  });
  expect(allowed.source("0")?.plaintext).toContain(
    "session/request_permission",
  );
  expect(allowed.source("1")?.plaintext).toContain("selected-option");
  for (const options of [
    [{ ...option, kind: "unknown" }],
    [option, option],
    [],
    null,
  ]) {
    const entries =
      activityTranscript(records([request(options), source[1]])).groups[0]
        ?.entries ?? [];
    expect(entries.every((e) => !e.diagnostic)).toBe(true);
    expect(entries.map((e) => e.title)).not.toContain("Permission allowed");
  }
  for (const kind of ["reject_once", "reject_always"]) {
    const denied = activityTranscript(
      records([request([{ ...option, kind }]), source[1]]),
    );
    expect(denied.groups[0]?.entries[0]).toMatchObject({
      title: "Permission denied",
      diagnostic: false,
    });
  }
  expect(
    activityTranscript(
      records([request([option]), response({ outcome: "cancelled" })]),
    ).groups[0]?.entries[0],
  ).toMatchObject({ title: "Permission cancelled", diagnostic: false });
  for (const values of [
    [source[1], source[0]],
    [source[0], source[0], source[1]],
    [source[0], { ...source[1], sessionId: "other" }],
  ]) {
    const entries = activityTranscript(records(values)).groups.flatMap(
      (g) => g.entries,
    );
    expect(entries.some((e) => e.title === "Permission allowed")).toBe(false);
  }
});
it("puts known context delivery in diagnostics and lets late failure override completion", () => {
  const result = activityTranscript(
    records([
      event("prompt_context_delivery", { promptBytes: 100 }),
      update("tool_call", { toolCallId: "tool", status: "completed" }),
      update("tool_call_update", { toolCallId: "tool", status: "failed" }),
      update("tool_call_update", { toolCallId: "tool", status: "completed" }),
    ]),
  );
  expect(result.groups[0]?.entries[0]).toMatchObject({
    title: "Context delivered",
    diagnostic: true,
  });
  expect(result.groups[0]?.entries[1]?.status).toBe("failed");
});
it("keeps malformed empty permission choices primary and recovers after collided requests drain", () => {
  const request = (options: unknown[]) =>
    event("acp_read", {
      id: 1,
      method: "session/request_permission",
      params: { options },
    });
  const cancelled = event("acp_write", {
    id: 1,
    result: { outcome: { outcome: "cancelled" } },
  });
  const empty =
    activityTranscript(records([request([]), cancelled])).groups[0]?.entries ??
    [];
  expect(empty.map((e) => e.title)).toEqual([
    "Permission requested",
    "Permission response",
  ]);
  expect(empty.every((e) => !e.diagnostic)).toBe(true);
  const valid = request([{ optionId: "choice", kind: "allow_once" }]);
  const allowed = event("acp_write", {
    id: 1,
    result: { outcome: { outcome: "selected", optionId: "choice" } },
  });
  const recovered =
    activityTranscript(
      records([valid, valid, allowed, allowed, valid, allowed]),
    ).groups[0]?.entries ?? [];
  expect(
    recovered.filter((e) => e.title === "Permission allowed"),
  ).toHaveLength(1);
  expect(recovered.at(-1)?.sourceIds).toEqual(["4", "5"]);
});
