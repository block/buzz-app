import type { JsonValue, OpenTarget } from "../../features/navigation/targets";
import type { PageTabTarget } from "../../features/conversation/contracts";

/** Views an Activity address may name; some are no longer offered. */
export type ActivityFilter =
  | "all"
  | "channels"
  | "threads"
  | "mentions"
  | "dms"
  | "reactions"
  | "direct"
  | "working"
  | "waiting";
export type SenderFilter = "everyone" | "humans" | "agents";

/** Activity's address; the route contract below applies only to it. */
export const inboxTarget = {
  version: 1,
  kind: "page",
  pluginId: "buzz.inbox",
  pageId: "inbox",
} as const;

/** Filters an open asks Activity to show; omitted choices stay as saved. */
export type InboxFiltersRoute = {
  attention?: "all" | "unread";
  activity?: ActivityFilter;
  sender?: SenderFilter;
};
export type InboxRoute = InboxFiltersRoute & {
  compose?: "new";
  channelId?: string;
  messageId?: string;
  threadId?: string;
};
type Filters = Required<InboxFiltersRoute>;
const detailKeys = new Set(["channelId", "messageId", "threadId"]);
// Keyed by each union so a value added to one fails to compile until listed here.
const filters: {
  readonly [K in keyof Filters]: Readonly<Record<Filters[K], true>>;
} = {
  attention: { all: true, unread: true },
  activity: {
    all: true,
    channels: true,
    threads: true,
    mentions: true,
    dms: true,
    reactions: true,
    direct: true,
    working: true,
    waiting: true,
  },
  sender: { everyone: true, humans: true, agents: true },
};
// Links made while the page had Archived and Drafts views still open it:
// `show` is accepted and ignored, and `drafts` alone opens the saved filters.
const retiredShow: Readonly<Record<string, true>> = {
  inbox: true,
  archived: true,
};

function inboxRoute(params: JsonValue | undefined): InboxRoute | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return;
  const value = params as { readonly [key: string]: JsonValue };
  const keys = Object.keys(value);
  // buzz:// plugin links carry every route value as a string.
  if (keys.includes("drafts"))
    return keys.length === 1 &&
      (value.drafts === true || value.drafts === "true")
      ? {}
      : undefined;
  if (
    keys.some((key) => {
      const choice = value[key];
      if (typeof choice !== "string") return true;
      if (key === "compose") return choice !== "new";
      if (detailKeys.has(key))
        return !choice.length || choice.length > 1024 || /\s/.test(choice);
      if (key === "show") return !Object.hasOwn(retiredShow, choice);
      return (
        !Object.hasOwn(filters, key) ||
        !Object.hasOwn(filters[key as keyof Filters], choice)
      );
    })
  )
    return;
  if ((value.messageId || value.threadId) && !value.channelId) return;
  if (value.compose && value.channelId) return;
  return Object.fromEntries(
    keys.filter((key) => key !== "show").map((key) => [key, value[key]]),
  ) as InboxRoute;
}

export const isInboxRoute = (params: JsonValue) => !!inboxRoute(params);

/** The route a visit carries, if any; a plain Activity open has none. */
function addressedRoute(target: OpenTarget | undefined) {
  if (
    target?.kind !== "page" ||
    target.pluginId !== "buzz.inbox" ||
    target.pageId !== "inbox" ||
    target.route?.version !== 1
  )
    return;
  return inboxRoute(target.route.params);
}
export function routeOf(
  target: OpenTarget | undefined,
): InboxFiltersRoute | undefined {
  const route = addressedRoute(target);
  if (!route) return;
  const {
    channelId: _channel,
    messageId: _message,
    threadId: _thread,
    compose: _compose,
    ...filters
  } = route;
  return filters;
}
export const composingOf = (target: OpenTarget | undefined) =>
  addressedRoute(target)?.compose === "new";
export function detailOf(
  target: OpenTarget | undefined,
): PageTabTarget | undefined {
  const route = addressedRoute(target);
  return route?.channelId
    ? {
        channelId: route.channelId,
        ...(route.messageId && { messageId: route.messageId }),
        ...(route.threadId && { threadId: route.threadId }),
      }
    : undefined;
}

/** An open that shows Activity with these filters applied. */
export const inboxRouteTarget = (params: InboxRoute) => ({
  ...inboxTarget,
  route: { version: 1 as const, params },
});
