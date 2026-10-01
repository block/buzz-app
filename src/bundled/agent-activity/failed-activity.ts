const object = (value: unknown): { [key: string]: unknown } | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as { [key: string]: unknown })
    : undefined;

export function activityErrorText(payload: unknown): string {
  const error = object(payload)?.error;
  const detail = typeof error === "string" ? error : object(error)?.message;
  if (typeof detail !== "string" || !detail.trim())
    return "The agent reported an error. See raw details for the received event.";
  return detail.length > 4096
    ? `${detail.slice(0, 4096)}\n… Error shortened; full retained event is available in Raw events.`
    : detail;
}
