const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const label = (pluginId: string, text: string) =>
  `[Buzz plugin: ${pluginId}]${text ? ` ${text}` : ""}`;

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
 * such as each plugin's `UserPromptSubmit` reminder, one paragraph each;
 * undefined when any response does more. */
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
      additionalContext: texts.join("\n\n"),
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
