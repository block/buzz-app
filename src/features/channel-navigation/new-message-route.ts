import type {
  JsonValue,
  NavigationScope,
  OpenTarget,
} from "../navigation/targets";

// Kept apart from the rest of the Channels routes so links can address a
// draft without importing every Channels route and its dependencies.

const personKey = /^[0-9a-f]{64}$/;

/** Choosing to message one person: who, and when it was chosen. */
export type MessageIntent = Readonly<{ to: string; at: number }>;

/** A new direct message, addressed to one person when opened from them.
 * Nothing exists on the relay until its first send. */
export function newMessage(
  params: JsonValue | undefined,
): { intent?: MessageIntent } | undefined {
  if (params === "new-message") return {};
  if (!params || typeof params !== "object" || Array.isArray(params)) return;
  const { kind, to, at, ...rest } = params as {
    readonly [key: string]: JsonValue;
  };
  if (
    kind === "new-message" &&
    !Object.keys(rest).length &&
    typeof to === "string" &&
    personKey.test(to) &&
    typeof at === "number" &&
    Number.isSafeInteger(at) &&
    at > 0
  )
    return { intent: { to, at } };
}

const intentOrder = "buzz-message-intent.v1";
let issued = 0;
/** The order of a new choice: after every earlier one, in every window,
 * even when the clock moves back. */
export function nextMessageIntent() {
  let last = issued;
  try {
    last = Math.max(last, Number(localStorage.getItem(intentOrder)) || 0);
  } catch {
    /* Without storage, this window still orders its own choices. */
  }
  issued = Math.max(Date.now(), last + 1);
  try {
    localStorage.setItem(intentOrder, String(issued));
  } catch {
    /* As above. */
  }
  return issued;
}

/** A New message draft addressed to `to`. Each choice is its own visit,
 * ordered after every earlier one, so choosing the same person again
 * addresses it anew. */
export const newMessageTarget = (
  scope: NavigationScope,
  to: string,
  at = nextMessageIntent(),
): OpenTarget => ({
  version: 1,
  kind: "page",
  pluginId: "buzz.channels",
  pageId: "channels",
  scope,
  route: { version: 1, params: { kind: "new-message", to, at } },
});
