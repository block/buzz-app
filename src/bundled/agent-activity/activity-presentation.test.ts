import { expect, it } from "vitest";
import {
  workingActivityLabel,
  activityAction,
  activityPresentation,
  groupActivity,
  toolGroupSummary,
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
it("groups only adjacent tools and exposes failures alongside live or stale work", () => {
  const command = entry("buzz-dev-mcp__shell");
  const running = { ...command, id: "running", status: "in_progress" };
  const failed = { ...command, id: "failed", status: "failed" };
  const thought = { ...command, id: "commentary", kind: "thought" as const };
  expect(
    groupActivity([command, running, thought, failed]).map((g) => g.length),
  ).toEqual([2, 1, 1]);
  expect(toolGroupSummary([running, failed], true)).toEqual({
    label: "2 commands",
    status: "1 failed · 1 active",
    active: true,
  });
  expect(toolGroupSummary([running, failed], false).status).toBe(
    "1 failed · 1 last seen active",
  );
  expect(toolGroupSummary([command, command], false)).toEqual({
    label: "2 commands",
    status: "Completed",
    active: false,
  });
  const nonzero = entry(
    "buzz-dev-mcp__shell",
    {},
    JSON.stringify({
      stdout: "",
      stderr: "bad",
      exit_code: 1,
      timed_out: false,
      stdout_truncated: false,
      stderr_truncated: false,
    }),
  );
  expect(toolGroupSummary([nonzero, command], false).status).toBe("1 failed");
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

it("derives only current, unambiguous structured work, with no private excerpts", () => {
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
  expect(label()).toBe("Running a command…");
  push({
    sessionUpdate: "tool_call_update",
    toolCallId: "command",
    status: "completed",
  });
  expect(label()).toBe("Last action: Run command");
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
  ["unknown", "tool", "Working…", "Working…"],
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
