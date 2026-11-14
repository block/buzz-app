import type { JsonValue, OpenTarget } from "../navigation/targets";
export type DraftsSentTab = "drafts" | "scheduled" | "sent";
export function isDraftsSentRoute(value: JsonValue): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, JsonValue>;
  return (
    Object.keys(record).length === 1 &&
    ["drafts", "scheduled", "sent"].includes(String(record.tab))
  );
}
export function draftsSentRoute(
  target: OpenTarget | undefined,
): DraftsSentTab | undefined {
  if (
    target?.kind !== "page" ||
    target.route?.version !== 1 ||
    !isDraftsSentRoute(target.route.params)
  )
    return;
  return (target.route.params as { tab: DraftsSentTab }).tab;
}
export const scheduledMessagesLink =
  "buzz://plugin?id=buzz.drafts-and-sent&page=drafts-sent&route.tab=scheduled";
