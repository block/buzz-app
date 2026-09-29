import type { ActivityTurn } from "../../features/agents/activity";
import { activityPresentation } from "./activity-presentation";
import type { activityTranscript, TranscriptEntry } from "./transcript";

const short = (value: string) =>
  value
    .replace(/\p{Cc}/gu, " ")
    .trim()
    .slice(0, 100);
function argument(input: string): string {
  try {
    const value: unknown = JSON.parse(input);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const first = Object.values(value)[0];
      return (
        short(
          typeof first === "string" ? first : (JSON.stringify(first) ?? ""),
        ) || "target not reported"
      );
    }
  } catch {
    /* Missing input stays explicitly unavailable. */
  }
  return "target not reported";
}

/** A display-only command sketch, never shell execution or send evidence.
 * Read just the command header (not heredoc bodies), preserving quoted tokens.
 * Complex shell expansion stays unnamed rather than being interpreted. */
export function commandTarget(command: string): string {
  const header = command.split(/\r?\n/).find((line) => line.trim()) ?? "";
  if (/[`]|\$[({]/.test(header)) return "shell script";
  const tokens =
    header.match(/"[^"\n]*"|'[^'\n]*'|&&|\|\||[|;<>]|[^\s|;&<>]+/g) ?? [];
  const commands: string[][] = [[]];
  for (const token of tokens) {
    if (["|", "&&", ";", "||"].includes(token)) commands.push([]);
    else
      commands[commands.length - 1]?.push(
        token.replace(/^(['"])(.*)\1$/, "$2"),
      );
  }
  const meaningful = commands.filter(
    (parts) => parts.length && !["cd", "export"].includes(parts[0] ?? ""),
  );
  const parts = meaningful[0] ?? commands[0] ?? [];
  // A heredoc pipe commonly feeds a CLI. Name that recipient, not the text feeder.
  const selected =
    parts.includes("<") && meaningful.length > 1
      ? (meaningful[1] ?? parts)
      : parts;
  const program = selected[0]?.split("/").at(-1);
  if (!program || !/^[\w.-]+$/.test(program)) return "shell script";
  // Only these familiar flags consume the following token. This is a label
  // sketch, not a universal CLI grammar; never execute or expand shell input.
  const valueFlags: Record<string, readonly string[]> = {
    rg: [
      "-g",
      "--glob",
      "-t",
      "--type",
      "-T",
      "--type-not",
      "-A",
      "-B",
      "-C",
      "--context",
      "-m",
      "--max-count",
    ],
    grep: [
      "-A",
      "-B",
      "-C",
      "--context",
      "-m",
      "--max-count",
      "--include",
      "--exclude",
    ],
    tail: ["-n", "--lines", "-c", "--bytes"],
    head: ["-n", "--lines", "-c", "--bytes"],
    git: ["-C", "-c", "--git-dir", "--work-tree"],
    buzz: ["--format", "--relay", "--private-key", "--auth-tag"],
  };
  const args: string[] = [];
  let operandsOnly = false;
  for (let index = 1; index < selected.length; index++) {
    const token = selected[index];
    if (!token || /^[<>]/.test(token)) break;
    if (!operandsOnly && token === "--") {
      operandsOnly = true;
      continue;
    }
    if (!operandsOnly && token.startsWith("-")) {
      if (valueFlags[program]?.includes(token)) index++;
      continue;
    }
    args.push(token);
    if (args.length === (program === "buzz" ? 2 : 1)) break;
  }
  return short([program, ...args].join(" "));
}

/** Conversation work excludes duplicate messages and protocol diagnostics. */
export function liveWork(entry: TranscriptEntry): boolean {
  if (entry.diagnostic) return false;
  if (entry.title.startsWith("Permission "))
    return entry.title !== "Permission allowed";
  return ["tool", "thought", "plan"].includes(entry.kind);
}

export function liveAction(entry: TranscriptEntry): string {
  if (entry.kind === "thought") return "Thinking through this request";
  if (entry.kind === "plan") return "Planning this request";
  if (entry.title.startsWith("Permission ")) {
    // Permission scope is carried by the original control request, not model text.
    return `${entry.title} · ${argument(entry.input)}`;
  }
  if (entry.title === "Turn error")
    return `Request failed · ${short(entry.body) || "reason not reported"}`;
  const presentation = activityPresentation(entry);
  const target = presentation.command
    ? commandTarget(presentation.command)
    : presentation.target || argument(entry.input);
  const verb =
    entry.toolName === "buzz-dev-mcp__read_file"
      ? "Reading"
      : entry.toolName === "buzz-dev-mcp__str_replace"
        ? "Editing"
        : entry.toolName === "buzz-dev-mcp__view_image"
          ? "Viewing"
          : entry.toolName === "buzz-dev-mcp__shell"
            ? "Running"
            : `Using ${short(entry.toolName || entry.title)}`;
  if (entry.status === "failed" || presentation.shellOutput?.failed)
    return `${verb} ${target} failed · ${short(presentation.shellOutput?.note || entry.output) || "reason not reported"}`;
  if (entry.status === "completed") {
    const finished =
      entry.toolName === "buzz-dev-mcp__read_file"
        ? "Read"
        : entry.toolName === "buzz-dev-mcp__str_replace"
          ? "Edited"
          : entry.toolName === "buzz-dev-mcp__view_image"
            ? "Viewed"
            : entry.toolName === "buzz-dev-mcp__shell"
              ? "Ran"
              : `Used ${short(entry.toolName || entry.title)}`;
    return `${finished} ${target}`;
  }
  return `${verb} ${target}`;
}

/** Lifecycle remains authoritative. This projection never infers completion. */
export function liveTranscript(
  transcript: ReturnType<typeof activityTranscript>,
  turns: readonly ActivityTurn[],
) {
  return {
    ...transcript,
    groups: transcript.groups
      .filter((group) =>
        turns.some(
          (turn) =>
            turn.agent === group.agent &&
            turn.channelId === group.channelId &&
            turn.turnId === group.turnId &&
            turn.state !== "ended",
        ),
      )
      .map((group) => ({
        ...group,
        entries: group.entries.filter(liveWork).map((entry) => {
          if (!entry.title.startsWith("Permission ")) return entry;
          const source = transcript.source(entry.sourceIds[0] ?? "");
          try {
            const call = JSON.parse(source?.plaintext ?? "null")?.payload
              ?.params?.toolCall;
            if (call)
              return {
                ...entry,
                input: JSON.stringify({
                  action: call.title || call.toolCallId || "requested action",
                }),
              };
          } catch {
            /* Raw evidence remains available below the line. */
          }
          return entry;
        }),
      })),
  };
}

export function liveLabel(
  transcript: ReturnType<typeof activityTranscript>,
): string {
  const entries = transcript.groups
    .flatMap((group) => group.entries)
    .filter(liveWork);
  const order = (entry: TranscriptEntry) =>
    Math.max(
      ...entry.sourceIds.map(
        (id) => transcript.sourceOrder.get(id) ?? -Infinity,
      ),
    );
  const active = entries.filter(
    (entry) =>
      entry.kind === "tool" &&
      ["pending", "in_progress"].includes(entry.status),
  );
  const permissions = entries.filter(
    (entry) => entry.title === "Permission requested",
  );
  const latest = (
    permissions.length ? permissions : active.length ? active : entries
  ).reduce<TranscriptEntry | undefined>(
    (previous, entry) =>
      !previous || order(entry) > order(previous) ? entry : previous,
    undefined,
  );
  return latest
    ? `${liveAction(latest)}${active.length > 1 ? ` · ${active.length - 1} more actions running` : ""}`
    : "Working…";
}

/** Hide the live tail once its reported reply is actually present in this thread.
 * This changes presentation only; a send never ends the underlying turn. */
export function liveReplyVisible(
  transcript: ReturnType<typeof activityTranscript>,
  messageIds: readonly string[],
): boolean {
  const order = (entry: TranscriptEntry) =>
    Math.max(
      ...entry.sourceIds.map(
        (id) => transcript.sourceOrder.get(id) ?? -Infinity,
      ),
    );
  return (
    transcript.groups.length > 0 &&
    transcript.groups.every((group) => {
      const delivered = group.entries.filter(
        (entry) =>
          entry.status === "completed" &&
          entry.communication?.direction === "outgoing" &&
          !!entry.communication.eventId &&
          messageIds.includes(entry.communication.eventId),
      );
      if (!delivered.length) return false;
      const boundary = Math.max(...delivered.map(order));
      return !group.entries.some((entry) => {
        if (
          !liveWork(entry) ||
          entry.kind === "thought" ||
          entry.toolName === "buzz-dev-mcp___Stop" ||
          delivered.includes(entry)
        )
          return false;
        return (
          order(entry) > boundary ||
          (entry.kind === "tool" &&
            ["pending", "in_progress"].includes(entry.status))
        );
      });
    })
  );
}
