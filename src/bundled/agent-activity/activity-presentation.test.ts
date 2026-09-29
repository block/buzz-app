import { expect, it } from "vitest";
import {
  workingActivityLabel,
  activityAction,
  activityPresentation,
} from "./activity-presentation";
import { activityTranscript, type TranscriptEntry } from "./transcript";
import type { ActivityRecord } from "../../features/agents/activity-records";
const entry = (
  toolName: string,
  input: unknown = {},
  output = "",
): TranscriptEntry => ({
  id: "tool",
  kind: "tool",
  title: toolName,
  toolName,
  input: JSON.stringify(input),
  output,
  body: "",
  status: "completed",
  sourceIds: [],
});
it("maps only exact tools and structured paths; commands remain indivisible", () => {
  expect(
    activityPresentation(
      entry("buzz-dev-mcp__read_file", { path: "/work/src/Composer.tsx" }),
    ),
  ).toMatchObject({ title: "Read file", target: "Composer.tsx" });
  expect(
    activityPresentation(
      entry("buzz-dev-mcp__str_replace", { path: "C:\\work\\Composer.tsx" }),
    ),
  ).toMatchObject({ title: "Edit file", target: "Composer.tsx" });
  expect(
    activityPresentation(
      entry("buzz-dev-mcp__shell", {
        workdir: "/work/project",
        command: "read file; send message",
      }),
    ),
  ).toMatchObject({ title: "Run command", target: "read file; send message" });
  expect(
    activityPresentation(entry("unknown_shell", { path: "/work/secret" })),
  ).toMatchObject({ title: "unknown_shell", target: undefined });
});
it("never invents a file target from malformed or directory paths", () => {
  for (const path of [
    "",
    "/",
    "/work/",
    "C:\\",
    "..",
    12,
    { path: "file" },
    "a\nb",
  ]) {
    expect(
      activityPresentation(entry("buzz-dev-mcp__read_file", { path })),
    ).toMatchObject({ title: "buzz-dev-mcp__read_file", target: undefined });
  }
});
it("preserves stderr, empty output and wrapper warnings without interpreting markup", () => {
  const result = {
    stdout: "<script>inert</script>",
    stderr: "warning",
    exit_code: 2,
    timed_out: false,
    stdout_truncated: true,
    stderr_truncated: false,
  };
  expect(
    activityPresentation(
      entry("buzz-dev-mcp__shell", {}, JSON.stringify(result)),
    ).shellOutput,
  ).toEqual({
    stdout: "<script>inert</script>",
    stderr: "warning",
    failed: true,
    note: "Exit code 2 · Output was truncated by the tool",
  });
  expect(
    activityPresentation(
      entry(
        "buzz-dev-mcp__shell",
        {},
        JSON.stringify({ ...result, stdout: "", stderr: "" }),
      ),
    ).shellOutput?.stdout,
  ).toBe("");
  expect(
    activityPresentation(entry("other", {}, JSON.stringify(result)))
      .shellOutput,
  ).toBeUndefined();
  for (const output of [
    "broken",
    JSON.stringify({ ...result, stderr: null }),
    JSON.stringify({ stdout: "hi" }),
  ])
    expect(
      activityPresentation(entry("buzz-dev-mcp__shell", {}, output))
        .shellOutput,
    ).toBeUndefined();
});
it("previews distinct command text rather than repeated working directories", () => {
  const first = activityPresentation(
    entry("buzz-dev-mcp__shell", {
      command: "\ncat > REPORT.md <<'EOF'\nprivate text",
      workdir: ".buzz",
    }),
  );
  const second = activityPresentation(
    entry("buzz-dev-mcp__shell", {
      command: "wc -w REPORT.md",
      workdir: ".buzz",
    }),
  );
  expect(first.target).toBe("cat > REPORT.md <<'EOF'");
  expect(second.target).toBe("wc -w REPORT.md");
  expect(first.target).not.toContain("private text");
  expect(
    activityPresentation(
      entry("buzz-dev-mcp__shell", { command: "x".repeat(120) }),
    ).target,
  ).toBe(`${"x".repeat(90)}…`);
  expect(
    activityPresentation(
      entry("buzz-dev-mcp__shell", { command: "\t\u001bwc -w file" }),
    ).target,
  ).toBe("wc -w file");
});

it("derives current structured commands without exposing thought or response excerpts", () => {
  const records: ActivityRecord[] = [];
  const turn = {
    agent: "agent",
    channelId: "alpha",
    turnId: "T",
    timestamp: 0,
    state: "working" as const,
  };
  const push = (update: unknown, turnId = "T", channelId = "alpha") =>
    records.push({
      id: String(records.length),
      envelopeId: String(records.length),
      agent: "agent",
      kind: "acp_read",
      receivedAt: records.length,
      plaintext: JSON.stringify({
        kind: "acp_read",
        turnId,
        channelId,
        payload: {
          method: "session/update",
          params: { sessionId: "S", update },
        },
      }),
    });
  const label = () => workingActivityLabel(activityTranscript(records), [turn]);
  expect(label()).toBe("Working…");
  push({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "private reasoning" },
  });
  expect(label()).toBe("Thinking…");
  push({
    sessionUpdate: "tool_call",
    toolCallId: "command",
    title: "buzz-dev-mcp__shell",
    status: "pending",
    rawInput: { command: "private command" },
  });
  expect(label()).toBe("Running private command");
  push({
    sessionUpdate: "tool_call_update",
    toolCallId: "command",
    status: "completed",
  });
  expect(label()).toBe("Last action: Run command · private command");
  push({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "private response" },
  });
  expect(label()).toBe("Writing a response…");
  push({
    sessionUpdate: "tool_call",
    toolCallId: "read",
    title: "buzz-dev-mcp__read_file",
    status: "in_progress",
  });
  expect(label()).toBe("Reading file…");
  push({
    sessionUpdate: "tool_call",
    toolCallId: "edit",
    title: "buzz-dev-mcp__str_replace",
    status: "in_progress",
  });
  expect(label()).toBe("Working…"); // Parallel tools never choose one arbitrarily.
  push({
    sessionUpdate: "tool_call_update",
    toolCallId: "read",
    status: "completed",
  });
  expect(label()).toBe("Editing file…");
  push({
    sessionUpdate: "tool_call_update",
    toolCallId: "edit",
    status: "completed",
  });
  expect(label()).toBe("Last action: Edit file"); // Folded update is newer than the response row.
  push(
    {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "different run" },
    },
    "other",
  );
  push(
    {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "different channel" },
    },
    "T",
    "beta",
  );
  expect(label()).toBe("Last action: Edit file");
  const transcript = activityTranscript(records);
  expect(
    workingActivityLabel(transcript, [turn, { ...turn, turnId: "other" }]),
  ).toBe("Working…");
  expect(
    workingActivityLabel(transcript, [{ ...turn, state: "unknown" }]),
  ).toBe("Working…");
  expect(workingActivityLabel(transcript, [{ ...turn, state: "ended" }])).toBe(
    "Working…",
  );
});

it.each([
  [
    "buzz-dev-mcp__shell",
    "command",
    "Running a command…",
    "Last action: Run command",
  ],
  [
    "buzz-dev-mcp__read_file",
    "read",
    "Reading file…",
    "Last action: Read file",
  ],
  [
    "buzz-dev-mcp__str_replace",
    "edit",
    "Editing file…",
    "Last action: Edit file",
  ],
  [
    "buzz-dev-mcp__view_image",
    "image",
    "Viewing image…",
    "Last action: View image",
  ],
  ["unknown", "tool", "Using unknown", "Last action: unknown"],
])(
  "uses exact %s semantics for active/completed action and icon",
  (toolName, action, active, completed) => {
    const item = entry(toolName, {
      command: "cat private.md > edited.md",
      path: "/private/file.md",
    });
    expect(activityAction(item)).toBe(action);
    const record: ActivityRecord = {
      id: "one",
      envelopeId: "one",
      agent: "agent",
      kind: "acp_read",
      receivedAt: 0,
      plaintext: "",
    };
    const label = (status: string) =>
      workingActivityLabel(
        activityTranscript([
          {
            ...record,
            plaintext: JSON.stringify({
              kind: "acp_read",
              turnId: "T",
              channelId: "alpha",
              payload: {
                method: "session/update",
                params: {
                  update: {
                    sessionUpdate: "tool_call",
                    toolCallId: "one",
                    title: toolName,
                    status,
                  },
                },
              },
            }),
          },
        ]),
        [
          {
            agent: "agent",
            channelId: "alpha",
            turnId: "T",
            timestamp: 0,
            state: "working",
          },
        ],
      );
    expect(label("in_progress")).toBe(active);
    expect(label("completed")).toBe(completed);
    expect(label("failed")).toBe("Working…");
    expect(label("unknown")).toBe("Working…");
  },
);

it.each([
  "{malformed",
  JSON.stringify({ exit_code: 1 }),
  JSON.stringify({ isError: true }),
  JSON.stringify({
    stdout: "",
    stderr: "failed",
    exit_code: 1,
    timed_out: false,
    stdout_truncated: false,
    stderr_truncated: false,
  }),
])(
  "describes an invocation, not successful work, for completed failure output %s",
  (output) => {
    const record: ActivityRecord = {
      id: "one",
      envelopeId: "one",
      agent: "agent",
      kind: "acp_read",
      receivedAt: 0,
      plaintext: JSON.stringify({
        kind: "acp_read",
        turnId: "T",
        channelId: "alpha",
        payload: {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tool",
              title: "buzz-dev-mcp__shell",
              status: "completed",
              content: [
                { type: "content", content: { type: "text", text: output } },
              ],
            },
          },
        },
      }),
    };
    const label = workingActivityLabel(activityTranscript([record]), [
      {
        agent: "agent",
        channelId: "alpha",
        turnId: "T",
        timestamp: 0,
        state: "working",
      },
    ]);
    expect(label).toBe("Last action: Run command");
    expect(label).not.toMatch(/success|completed|Running|Ran /i);
  },
);

it("uses a bounded literal command or file target in the working headline, not thoughts or output", () => {
  const turn = {
    agent: "agent",
    channelId: "alpha",
    turnId: "T",
    timestamp: 0,
    state: "working" as const,
  };
  const label = (tool: TranscriptEntry) =>
    workingActivityLabel(
      {
        ...activityTranscript([]),
        groups: [
          {
            id: "g",
            agent: "agent",
            channelId: "alpha",
            turnId: "T",
            sessionId: null,
            receivedAt: 0,
            entries: [tool],
          },
        ],
      },
      [turn],
    );
  expect(
    label({
      ...entry("buzz-dev-mcp__shell", {
        command: "pnpm test --filter activity",
      }),
      status: "in_progress",
    }),
  ).toBe("Running pnpm test --filter activity");
  expect(
    label({
      ...entry("buzz-dev-mcp__read_file", {
        path: "/work/src/ActivityPanel.tsx",
      }),
      status: "pending",
    }),
  ).toBe("Reading ActivityPanel.tsx");
  const command = `printf '${"a".repeat(120)}'\nprivate heredoc body`;
  const text = label({
    ...entry("buzz-dev-mcp__shell", { command }),
    status: "in_progress",
  });
  expect(text.length).toBeLessThanOrEqual(99);
  expect(text).not.toContain("heredoc");
  expect(text).toContain("…");
  expect(label({ ...entry("unmapped_tool"), status: "in_progress" })).toBe(
    "Using unmapped_tool",
  );
});

it("classifies tools by explicit event kind, never by familiar harness/tool names or completion", async () => {
  const { activityCategory } = await import("./activity-presentation");
  const tool = entry("harness_specific_tool");
  for (const status of ["pending", "in_progress", "completed", "failed"]) {
    expect(activityCategory({ ...tool, status })).toBe("operation");
    expect(
      activityCategory({
        ...tool,
        status,
        communication: {
          direction: "outgoing",
          body: "hello",
          author: "agent",
        },
      }),
    ).toBe("operation");
  }
  expect(activityCategory({ ...tool, kind: "plan" })).toBe("operation");
  for (const kind of ["prompt", "thought", "message"] as const)
    expect(activityCategory({ ...tool, kind })).toBe("communication");
  expect(
    activityCategory({ ...tool, kind: "event", title: "unknown_tool" }),
  ).toBe("diagnostic");
  expect(activityCategory({ ...tool, kind: "prompt", diagnostic: true })).toBe(
    "diagnostic",
  );
});
