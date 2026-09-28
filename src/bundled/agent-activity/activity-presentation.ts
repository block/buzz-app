import type { ActivityTurn } from "../../features/agents/activity";
import type { activityTranscript } from "./transcript";
import type { TranscriptEntry } from "./transcript";
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
function parsed(value: string) {
  try {
    return object(JSON.parse(value));
  } catch {
    return;
  }
}
function basename(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /[/\\]$/.test(value) ||
    /[\r\n]/.test(value)
  )
    return;
  const name = value.split(/[/\\]/).at(-1);
  return name && name !== "." && name !== ".." ? name : undefined;
}

const toolActions = {
  "buzz-dev-mcp__shell": {
    action: "command",
    active: "Running a command…",
    completed: "Last action: Run command",
  },
  "buzz-dev-mcp__read_file": {
    action: "read",
    active: "Reading file…",
    completed: "Last action: Read file",
  },
  "buzz-dev-mcp__str_replace": {
    action: "edit",
    active: "Editing file…",
    completed: "Last action: Edit file",
  },
  "buzz-dev-mcp__view_image": {
    action: "image",
    active: "Viewing image…",
    completed: "Last action: View image",
  },
} as const;
function knownTool(entry: TranscriptEntry) {
  const name = entry.toolName ?? entry.title;
  return Object.hasOwn(toolActions, name)
    ? toolActions[name as keyof typeof toolActions]
    : undefined;
}
/** Exact reported kinds only. Shell input never changes its action category. */
export function activityAction(entry: TranscriptEntry) {
  if (entry.kind === "tool") return knownTool(entry)?.action ?? "tool";
  if (entry.kind === "thought") return "thought";
  if (entry.kind === "message" || entry.kind === "prompt") return "message";
  return "event";
}

/** Display only. Never feeds send association, status, permissions or execution. */
export function activityPresentation(entry: TranscriptEntry) {
  const input = parsed(entry.input);
  const name = entry.toolName ?? entry.title;
  let title = entry.title,
    target: string | undefined;
  if (name === "buzz-dev-mcp__shell") {
    title = "Run command";
    const line =
      typeof input?.command === "string"
        ? input.command
            .split(/\r?\n/)
            .find((part) => part.trim())
            ?.replace(/\p{Cc}/gu, " ")
            .trim()
        : undefined;
    target = line
      ? `${line.slice(0, 90)}${line.length > 90 ? "…" : ""}`
      : undefined;
  } else if (
    name === "buzz-dev-mcp__read_file" ||
    name === "buzz-dev-mcp__str_replace" ||
    name === "buzz-dev-mcp__view_image"
  ) {
    target = basename(input?.path);
    title = target
      ? name.endsWith("read_file")
        ? "Read file"
        : name.endsWith("str_replace")
          ? "Edit file"
          : "View image"
      : entry.title;
  }
  // Only unwrap the observed shell wrapper. Missing/malformed fields retain the
  // exact output text; raw source is accessible for every presentation below.
  const result =
    name === "buzz-dev-mcp__shell" ? parsed(entry.output) : undefined;
  const shellOutput =
    result &&
    typeof result.stdout === "string" &&
    typeof result.stderr === "string" &&
    Number.isInteger(result.exit_code) &&
    typeof result.timed_out === "boolean" &&
    typeof result.stdout_truncated === "boolean" &&
    typeof result.stderr_truncated === "boolean"
      ? {
          stdout: result.stdout,
          stderr: result.stderr,
          failed: result.exit_code !== 0 || result.timed_out,
          note: [
            result.exit_code !== 0 ? `Exit code ${result.exit_code}` : "",
            result.timed_out ? "Command timed out" : "",
            result.stdout_truncated || result.stderr_truncated
              ? "Output was truncated by the tool"
              : "",
          ]
            .filter(Boolean)
            .join(" · "),
        }
      : undefined;
  const command =
    name === "buzz-dev-mcp__shell" && typeof input?.command === "string"
      ? input.command
      : undefined;
  return { title, target, shellOutput, command };
}

/** Contiguous primary tools only, within a single caller-owned turn/response.
 * Call after applying the compact work window, never across messages or agents. */
export function groupActivity(
  entries: readonly TranscriptEntry[],
): TranscriptEntry[][] {
  const groups: TranscriptEntry[][] = [];
  for (const entry of entries) {
    const previous = groups.at(-1);
    if (
      entry.kind === "tool" &&
      !entry.communication &&
      previous?.[0]?.kind === "tool" &&
      !previous[0].communication
    )
      previous.push(entry);
    else groups.push([entry]);
  }
  return groups;
}
export function toolGroupSummary(
  entries: readonly TranscriptEntry[],
  working: boolean,
) {
  const active = entries.filter((entry) =>
    ["pending", "in_progress"].includes(entry.status),
  ).length;
  const failed = entries.filter((entry) => {
    const output = activityPresentation(entry).shellOutput;
    return entry.status === "failed" || !!output?.failed;
  }).length;
  const complete = entries.every((entry) =>
    ["completed", "failed"].includes(entry.status),
  );
  const commands = entries.every(
    (entry) => entry.toolName === "buzz-dev-mcp__shell",
  );
  const label = `${entries.length} ${commands ? "commands" : "tool calls"}`;
  const status = [
    failed ? `${failed} failed` : "",
    active
      ? `${active} ${working ? "active" : "last seen active"}`
      : complete && !failed
        ? "Completed"
        : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return { label, status, active: !!active };
}

/** A short action label from one fresh associated turn, never a private excerpt. */
export function workingActivityLabel(
  transcript: ReturnType<typeof activityTranscript>,
  turns: readonly ActivityTurn[],
): string {
  const working = turns.filter((turn) => turn.state === "working");
  if (working.length !== 1) return "Working…";
  const turn = working[0];
  const entries = transcript.groups
    .filter(
      (group) =>
        group.agent === turn?.agent &&
        group.channelId === turn.channelId &&
        group.turnId === turn.turnId,
    )
    .flatMap((group) => group.entries)
    .filter((entry) => !entry.diagnostic);
  const active = entries.filter(
    (entry) =>
      entry.kind === "tool" &&
      ["pending", "in_progress"].includes(entry.status),
  );
  if (active.length > 1) return "Working…";
  if (active.length === 1 && active[0])
    return knownTool(active[0])?.active ?? "Working…";
  const order = (entry: TranscriptEntry) =>
    Math.max(
      ...entry.sourceIds.map(
        (id) => transcript.sourceOrder.get(id) ?? -Infinity,
      ),
    );
  const latest = entries.reduce<TranscriptEntry | undefined>(
    (previous, entry) =>
      !previous || order(entry) > order(previous) ? entry : previous,
    undefined,
  );
  // Fast tools can complete between paints. Name the last reported operation,
  // not its outcome: completed invocation does not establish successful work.
  if (latest?.kind === "tool" && latest.status === "completed")
    return knownTool(latest)?.completed ?? "Working…";
  if (latest?.kind === "thought") return "Thinking…";
  if (latest?.kind === "message" && !latest.communication && latest.body.trim())
    return "Writing a response…";
  return "Working…";
}
