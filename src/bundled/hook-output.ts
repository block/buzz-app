const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
/** Plugin text can't carry a label of its own, so one plugin's text can't pass
 * for another's section once context is joined. */
const quoteLabels = (text: string) =>
  text.replace(/\[\s*Buzz plugin\s*:/gi, "[quoted Buzz plugin:");
const label = (pluginId: string, text: string) =>
  `[Buzz plugin: ${pluginId}]${text ? ` ${quoteLabels(text)}` : ""}`;

/** Bound on joined context, so plugins together can't flood the prompt. */
export const JOINED_CONTEXT_LIMIT = 10_000;
const TRUNCATED = " [truncated]";
/** Splits the limit fairly: short sections keep their text, and the rest
 * share what's left, so one long section can't crowd out the others. */
function fitSections(texts: readonly string[], separator: string): string[] {
  let left = JOINED_CONTEXT_LIMIT - separator.length * (texts.length - 1);
  const limits = new Map<number, number>();
  let remaining = texts.length;
  for (const [index, text] of [...texts.entries()].sort(
    ([, a], [, b]) => a.length - b.length,
  )) {
    const limit = Math.min(text.length, Math.floor(left / remaining));
    limits.set(index, limit);
    left -= limit;
    remaining -= 1;
  }
  return texts.map((text, index) => {
    const limit = limits.get(index) ?? text.length;
    return text.length > limit
      ? text.slice(0, Math.max(0, limit - TRUNCATED.length)) + TRUNCATED
      : text;
  });
}

/** Claude and Codex share these native hook explanation fields. */
export function nativeHookOutput(output: unknown, pluginId: string): unknown {
  if (!record(output)) return output;
  const result = { ...output };
  for (const key of [
    "reason",
    "stopReason",
    "systemMessage",
    "additionalContext",
    "permissionDecisionReason",
    "message",
  ])
    if (typeof result[key] === "string")
      result[key] = label(pluginId, result[key]);
  const reason =
    output.decision === "block"
      ? "reason"
      : output.permissionDecision === "deny"
        ? "permissionDecisionReason"
        : output.continue === false
          ? "stopReason"
          : output.behavior === "deny"
            ? "message"
            : undefined;
  if (reason && typeof output[reason] !== "string")
    result[reason] = label(pluginId, "");
  for (const key of ["hookSpecificOutput", "decision"])
    if (record(output[key]))
      result[key] = nativeHookOutput(output[key], pluginId);
  return result;
}

/** Joins Claude and Codex responses that only add context to the same event,
 * such as each plugin's `UserPromptSubmit` reminder, one paragraph each and
 * within `JOINED_CONTEXT_LIMIT`; undefined when any response does more. */
export function joinNativeContext(outputs: readonly unknown[]): unknown {
  const texts: string[] = [];
  let event: unknown;
  for (const output of outputs) {
    const specific = record(output) ? output.hookSpecificOutput : undefined;
    if (
      !record(output) ||
      Object.keys(output).some((key) => key !== "hookSpecificOutput") ||
      !record(specific) ||
      typeof specific.additionalContext !== "string" ||
      Object.keys(specific).some(
        (key) => key !== "hookEventName" && key !== "additionalContext",
      ) ||
      (texts.length > 0 && specific.hookEventName !== event)
    )
      return undefined;
    event = specific.hookEventName;
    texts.push(specific.additionalContext);
  }
  if (outputs.length === 1) return outputs[0];
  return {
    hookSpecificOutput: {
      ...(event !== undefined && { hookEventName: event }),
      additionalContext: fitSections(texts, "\n\n").join("\n\n"),
    },
  };
}

/** Pi's arguments and opaque details are tool data, not hook explanations. */
export function piHookOutput(
  output: unknown,
  pluginId: string,
  input?: unknown,
): unknown {
  if (!record(output)) return output;
  return {
    ...output,
    ...(typeof output.block === "string" && {
      block: label(pluginId, output.block),
    }),
    ...(Array.isArray(output.output) &&
      !(record(input) && record(input.call) && input.call.parent != null) && {
        output: [{ type: "text", text: label(pluginId, "") }, ...output.output],
      }),
  };
}
