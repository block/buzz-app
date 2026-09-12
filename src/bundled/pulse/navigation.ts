import type { JsonValue } from "../../features/navigation/targets";

export type PulseRoute = {
  view: "all" | "for-you" | "search";
  search: string;
  channelId?: string;
  thread?: string;
};
export function validPulseRoute(value: JsonValue): value is PulseRoute {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const route = value as Record<string, JsonValue>;
  return (
    Object.keys(route).every((key) =>
      ["view", "search", "channelId", "thread"].includes(key),
    ) &&
    typeof route.view === "string" &&
    ["all", "for-you", "search"].includes(route.view) &&
    typeof route.search === "string" &&
    route.search.length <= 1024 &&
    (route.channelId === undefined ||
      (typeof route.channelId === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(route.channelId))) &&
    (route.thread === undefined ||
      (typeof route.channelId === "string" &&
        typeof route.thread === "string" &&
        /^[a-f0-9]{64}$/.test(route.thread)))
  );
}

export type FeedPosition = { top: number; focus?: string };
/** Plugin-lifetime, bounded visit geometry only; never message bodies or drafts. */
export function createPulsePositions() {
  const positions = new Map<string, FeedPosition>();
  return {
    get: (key: string) => positions.get(key),
    set(key: string, value: FeedPosition) {
      positions.delete(key);
      positions.set(key, value);
      if (positions.size > 100) {
        const first = positions.keys().next().value;
        if (first !== undefined) positions.delete(first);
      }
    },
  };
}
export type PulsePositions = ReturnType<typeof createPulsePositions>;
