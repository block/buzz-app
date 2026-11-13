import type { JsonValue } from "../../features/navigation/targets";

/** A submission address contains identity only; the current channel read owns access. */
export function submissionRoute(value: JsonValue | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const { channel, submission } = value as Record<string, JsonValue>;
  if (
    typeof channel === "string" &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(channel) &&
    typeof submission === "string" &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(submission)
  )
    return { channel, submission };
}
