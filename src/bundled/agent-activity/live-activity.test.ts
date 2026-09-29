import { expect, it } from "vitest";
import {
  commandTarget,
  liveAction,
  liveLabel,
  liveTranscript,
  liveWork,
} from "./live-activity";
import { activityTranscript, type TranscriptEntry } from "./transcript";
const entry = (extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  id: "one",
  kind: "tool",
  title: "lookup",
  toolName: "lookup",
  input: '{"query":"design tokens"}',
  output: "",
  body: "",
  status: "in_progress",
  sourceIds: ["one"],
  ...extra,
});
it("names unknown tools and targets without inventing semantics or exposing thought excerpts", () => {
  expect(liveAction(entry())).toBe("Using lookup design tokens");
  expect(liveAction(entry({ input: "malformed" }))).toBe(
    "Using lookup target not reported",
  );
  expect(liveAction(entry({ kind: "thought", body: "private thought" }))).toBe(
    "Thinking through this request",
  );
  expect(liveAction(entry({ status: "failed", output: "Access denied" }))).toBe(
    "Using lookup design tokens failed · Access denied",
  );
});
it("admits only work, never reply chunks, incoming messages, diagnostics or unknown protocol chatter", () => {
  expect(liveWork(entry())).toBe(true);
  for (const value of [
    entry({ diagnostic: true }),
    entry({ kind: "message", title: "Response" }),
    entry({ kind: "message", title: "Incoming message" }),
    entry({ kind: "event", title: "Other activity" }),
  ])
    expect(liveWork(value)).toBe(false);
});
it("shows concurrent actions on one line and excludes ended groups", () => {
  const transcript = {
    ...activityTranscript([]),
    groups: [
      {
        id: "group",
        agent: "agent",
        channelId: "channel",
        turnId: "turn",
        sessionId: null,
        receivedAt: 1,
        entries: [
          entry(),
          entry({ id: "two", input: '{"query":"layout"}', sourceIds: ["two"] }),
        ],
      },
    ],
    sourceOrder: new Map([
      ["one", 1],
      ["two", 2],
    ]),
  };
  expect(liveLabel(transcript)).toBe(
    "Using lookup layout · 1 more actions running",
  );
  expect(
    liveTranscript(transcript, [
      {
        agent: "agent",
        channelId: "channel",
        turnId: "turn",
        timestamp: 1,
        state: "ended",
      },
    ]).groups,
  ).toEqual([]);
});
it("names the actual permission target from the original control request", () => {
  const transcript = activityTranscript([
    {
      id: "permission",
      envelopeId: "permission",
      agent: "agent",
      receivedAt: 1,
      kind: "acp_read",
      plaintext: JSON.stringify({
        kind: "acp_read",
        turnId: "turn",
        channelId: "channel",
        payload: {
          id: "permission",
          method: "session/request_permission",
          params: { toolCall: { title: "Read design tokens" } },
        },
      }),
    },
  ]);
  const scoped = liveTranscript(transcript, [
    {
      agent: "agent",
      channelId: "channel",
      turnId: "turn",
      timestamp: 1,
      state: "working",
    },
  ]);
  expect(liveLabel(scoped)).toBe("Permission requested · Read design tokens");
});

it("sketches command headers without dumping flags, heredoc bodies or interpreting expansion", () => {
  expect(commandTarget("rg activity src")).toBe("rg activity");
  expect(commandTarget("git status --short")).toBe("git status");
  expect(commandTarget("cd /project && pnpm test --verbose")).toBe("pnpm test");
  expect(
    commandTarget(
      "cat <<'EOF' | buzz messages send --channel private\nsecret body\nEOF",
    ),
  ).toBe("buzz messages send");
  expect(commandTarget('rg "design tokens" src')).toBe("rg design tokens");
  expect(commandTarget("echo $(cat secret)")).toBe("shell script");
});
it("uses past tense for completed invocations without claiming the task succeeded", () => {
  expect(
    liveAction(
      entry({
        toolName: "buzz-dev-mcp__shell",
        status: "completed",
        input: '{"command":"rg tokens src"}',
      }),
    ),
  ).toBe("Ran rg tokens");
  expect(
    liveAction(
      entry({
        toolName: "buzz-dev-mcp__read_file",
        status: "completed",
        input: '{"path":"/project/tokens.css"}',
      }),
    ),
  ).toBe("Read tokens.css");
});

it.each([
  ["rg -n 'liveLabel' src/live-activity.ts", "rg liveLabel"],
  ["sed -n '40,140p' src/live-activity.ts", "sed 40,140p"],
  ["ls -la src/bundled/agent-activity", "ls src/bundled/agent-activity"],
  ["grep -r TODO src", "grep TODO"],
  ["tail -50 /var/log/x.log", "tail /var/log/x.log"],
  ["tail -n 50 /var/log/x.log", "tail /var/log/x.log"],
  ["find . -name '*.ts' | head", "find ."],
  ["rg -g '*.ts' -n liveLabel src", "rg liveLabel"],
  ["rg --glob='*.ts' -n liveLabel src", "rg liveLabel"],
  ["grep -C 3 TODO src", "grep TODO"],
  ["git -C /project rev-parse HEAD", "git rev-parse"],
  [
    "buzz --format compact messages send --channel private",
    "buzz messages send",
  ],
  ["rg -- -literal src", "rg -literal"],
  ["rg -n 123 src", "rg 123"],
])("keeps operands through familiar flags: %s", (command, expected) => {
  expect(commandTarget(command)).toBe(expected);
});

it("retains fast completed actions, posting, thoughts and plans during an active turn", () => {
  for (const value of [
    entry({ status: "completed" }),
    entry({ status: "pending" }),
    entry({ status: "" }),
    entry({ kind: "thought" }),
    entry({ kind: "plan" }),
    entry({ toolName: "buzz-dev-mcp___Stop" }),
    entry({ toolName: "send_message" }),
    entry({
      toolName: "buzz-dev-mcp__shell",
      input: JSON.stringify({ command: "buzz messages send --content hello" }),
    }),
  ])
    expect(liveWork(value)).toBe(true);
  expect(liveLabel(activityTranscript([]))).toBe("Working…");
});
