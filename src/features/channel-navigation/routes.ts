import type { JsonValue } from "../navigation/targets";

export type ChannelPlaceholder = "Inbox" | "Bestie";

export function channelPlaceholder(
  params: JsonValue | undefined,
): ChannelPlaceholder | undefined {
  return params === "Inbox" || params === "Bestie" ? params : undefined;
}

export function newSessionParent(
  params: JsonValue | undefined,
): string | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return;
  const value = params as { readonly [key: string]: JsonValue };
  if (
    value.kind !== "new-session" ||
    typeof value.parentId !== "string" ||
    !value.parentId.trim()
  )
    return;
  if (Object.keys(params).some((key) => key !== "kind" && key !== "parentId"))
    return;
  return value.parentId;
}

export function isChannelRoute(params: JsonValue) {
  return (
    params === "new-message" ||
    params === "empty" ||
    channelPlaceholder(params) !== undefined ||
    newSessionParent(params) !== undefined
  );
}
