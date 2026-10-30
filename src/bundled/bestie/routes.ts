import type { JsonValue, OpenTarget } from "../../features/navigation/targets";

type BestiePageTarget = Extract<OpenTarget, { kind: "page" }>;
export type BestieRoute = { messageId: string; threadRootId: string };
const hex = /^[0-9a-f]{64}$/;

export function bestieRoute(
  value: JsonValue | undefined,
): BestieRoute | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const route = value as Readonly<Record<string, JsonValue>>;
  if (
    Object.keys(route).length !== 2 ||
    typeof route.messageId !== "string" ||
    !hex.test(route.messageId) ||
    typeof route.threadRootId !== "string" ||
    !hex.test(route.threadRootId)
  )
    return;
  return { messageId: route.messageId, threadRootId: route.threadRootId };
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

export function bestieBaseTarget(target: BestiePageTarget): BestiePageTarget {
  const { route: _route, ...base } = target;
  return base;
}
