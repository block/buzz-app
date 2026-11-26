// What a harness's session updates show, and how its requests are answered.

const STEP_KEYS = [
  "description",
  "path",
  "file_path",
  "pattern",
  "url",
  "query",
  "command",
];

/** A `session/update` as the step it shows: a tool call by its title and
 * target, thinking, or writing. `origin` marks a call to the Buzz server. */
export function stepLabel(
  update: Record<string, unknown>,
): { tool: string; target?: string; origin?: "buzz" } | undefined {
  switch (update.sessionUpdate) {
    case "tool_call": {
      const title = typeof update.title === "string" ? update.title : "";
      // goose titles a call for people, `shell · sleep 10` or
      // `buzz: channel list`, and names the tool, `buzz__channel_list`, and
      // its extension, `buzz`, in `_meta`. The title is the fallback for a
      // harness without that field.
      const meta = update._meta as
        | {
            goose?: {
              toolCall?: { toolName?: unknown; extensionName?: unknown };
            };
          }
        | undefined;
      const call = meta?.goose?.toolCall;
      const name =
        typeof call?.toolName === "string" && call.toolName
          ? call.toolName
          : undefined;
      const full = name ?? title.split(" · ")[0] ?? "";
      const tool = full.split(/__|: /).at(-1)?.trim() || "Tool";
      // The extension as goose names it, else the name's own server prefix.
      const buzz =
        typeof call?.extensionName === "string"
          ? call.extensionName === "buzz"
          : /^(?:(?:mcp__)?buzz__|buzz: )/.test(full);
      const origin = buzz ? { origin: "buzz" as const } : {};
      const input = (update.rawInput ?? {}) as Record<string, unknown>;
      const target = STEP_KEYS.map((key) => input[key]).find(
        (value): value is string => typeof value === "string" && !!value,
      );
      return target
        ? { tool, target: shortTarget(target), ...origin }
        : { tool, ...origin };
    }
    case "agent_thought_chunk":
      return { tool: "Thinking" };
    case "agent_message_chunk":
      return { tool: "Writing reply" };
    default:
      return undefined;
  }
}

/** The option that allows the call, preferring one that keeps allowing. */
export function allow(params: Record<string, unknown>) {
  const options = Array.isArray(params.options)
    ? (params.options as { optionId?: unknown; kind?: unknown }[])
    : [];
  const option =
    options.find((item) => item.kind === "allow_always") ??
    options.find((item) => item.kind === "allow_once");
  return option && typeof option.optionId === "string"
    ? { outcome: "selected", optionId: option.optionId }
    : { outcome: "cancelled" };
}

/** The JSON-RPC code of a harness's error answer, when `error` is one. */
export function codeOf(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

export function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const { message, data } = error as { message: unknown; data?: unknown };
    return typeof data === "string" && data
      ? `${message}: ${data}`
      : String(message);
  }
  return String(error);
}

function shortTarget(value: string) {
  return value.startsWith("/") ? (value.split("/").at(-1) ?? value) : value;
}
