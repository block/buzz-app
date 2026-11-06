import type { JsonValue, OpenTarget } from "../../features/navigation/targets";

type BestiePageTarget = Extract<OpenTarget, { kind: "page" }>;
export type BestieRoute = {
  channelId: string;
  messageId: string;
  threadRootId: string;
};
/** One message of the DM, shown in its chat history when it is a top-level
 * message there, otherwise as its thread. */
export type BestieMessageRoute = {
  channelId: string;
  messageId: string;
  threadRootId?: undefined;
};
const hex = /^[0-9a-f]{64}$/;
const channelIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/;

function params(
  value: JsonValue | undefined,
  count: number,
): Readonly<Record<string, JsonValue>> | undefined {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === count
    ? (value as Readonly<Record<string, JsonValue>>)
    : undefined;
}

function field(
  route: Readonly<Record<string, JsonValue>> | undefined,
  key: string,
  pattern: RegExp,
): string | undefined {
  const value = route?.[key];
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

export function bestieRoute(
  value: JsonValue | undefined,
): BestieRoute | undefined {
  const route = params(value, 3);
  const channelId = field(route, "channelId", channelIdPattern);
  const messageId = field(route, "messageId", hex);
  const threadRootId = field(route, "threadRootId", hex);
  return channelId && messageId && threadRootId
    ? { channelId, messageId, threadRootId }
    : undefined;
}

export function bestieMessageRoute(
  value: JsonValue | undefined,
): BestieMessageRoute | undefined {
  const route = params(value, 2);
  const channelId = field(route, "channelId", channelIdPattern);
  const messageId = field(route, "messageId", hex);
  return channelId && messageId ? { channelId, messageId } : undefined;
}

export function bestieThreadTarget(
  target: BestiePageTarget,
  route: BestieRoute,
): BestiePageTarget {
  return {
    ...target,
    route: { version: 1, params: { ...route } },
  };
}

export function bestieMessageTarget(
  target: BestiePageTarget,
  { channelId, messageId }: BestieMessageRoute,
): BestiePageTarget {
  return { ...target, route: { version: 1, params: { channelId, messageId } } };
}

export function bestieBaseTarget(target: BestiePageTarget): BestiePageTarget {
  const { route: _route, ...base } = target;
  return base;
}

/** Bestie's visit for a visit to its DM, when its routes present it: the DM
 * itself, one of its threads or one of its messages. Forward and Members stay
 * in Messages. */
export function bestieConversationTarget(
  target: Extract<OpenTarget, { kind: "conversation" }>,
): BestiePageTarget | undefined {
  const { channelId, messageId, threadRootId } = target;
  if (target.panel || target.forward || target.detail) return;
  const base: BestiePageTarget = {
    version: 1,
    kind: "page",
    pluginId: "buzz.bestie",
    pageId: "bestie",
    scope: target.scope,
  };
  return threadRootId
    ? bestieThreadTarget(base, {
        channelId,
        messageId: messageId ?? threadRootId,
        threadRootId,
      })
    : messageId
      ? bestieMessageTarget(base, { channelId, messageId })
      : base;
}

export type BestieDetailRoute = {
  channelId: string;
  detail: string;
  rootId?: string;
};

/** Read-only panel address; the panel registry still decides what can open. */
export function bestieDetailRoute(
  value: JsonValue | undefined,
): BestieDetailRoute | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const route = value as Readonly<Record<string, JsonValue>>;
  if (
    Object.keys(route).some(
      (key) => !["channelId", "detail", "rootId"].includes(key),
    ) ||
    typeof route.channelId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(route.channelId) ||
    typeof route.detail !== "string" ||
    !route.detail.trim() ||
    route.detail.length > 8192 ||
    (route.rootId !== undefined &&
      (typeof route.rootId !== "string" || !hex.test(route.rootId)))
  )
    return;
  return {
    channelId: route.channelId,
    detail: route.detail,
    ...(typeof route.rootId === "string" && { rootId: route.rootId }),
  };
}

export function bestieDetailTarget(
  target: BestiePageTarget,
  route: BestieDetailRoute,
): BestiePageTarget {
  return { ...target, route: { version: 1, params: { ...route } } };
}
