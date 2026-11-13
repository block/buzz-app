import type { RelaySession } from "../relay/session";
import { readView, writeView } from "../../shared/view-state";

// Thread tab names are durable view intent for an account/community, unlike
// the tab layout: a thread's tab takes its name again when it reopens after a
// restart. One record keeps the 256 newest names, keyed `<channel>:<root>`,
// each `[name, savedAt]` with "" for a cleared one, oldest first. The bundled
// tab store reads and writes them; the session forgets them when a thread or
// channel goes, and leaving the community clears them with its other view
// state.
const NAMES = "tab-names";
const MAX_NAMES = 256;

const savedNames = (scope: string) => {
  const names = readView<unknown>(scope, NAMES, undefined);
  return new Map(
    names && typeof names === "object" && !Array.isArray(names)
      ? Object.entries(names)
      : [],
  );
};
/** Applies `edit`, which reports whether it changed the names. */
const editNames = (
  scope: string,
  edit: (names: Map<string, unknown>) => boolean,
) => {
  const names = savedNames(scope);
  if (edit(names))
    writeView(scope, NAMES, Object.fromEntries([...names].slice(-MAX_NAMES)));
};

const saved = (value: unknown) =>
  Array.isArray(value) &&
  typeof value[0] === "string" &&
  typeof value[1] === "number"
    ? { name: value[0], at: value[1] }
    : undefined;
/** A thread's saved name, "" once cleared, or undefined if never named. */
export function readThreadTabName(scope: string, key: string) {
  return saved(savedNames(scope).get(key))?.name;
}
/** Saves a name as the newest; undefined forgets it. */
export function saveThreadTabName(
  scope: string,
  key: string,
  name: string | undefined,
) {
  editNames(scope, (names) => {
    const existed = names.delete(key);
    if (name !== undefined) names.set(key, [name, Date.now()]);
    return existed || name !== undefined;
  });
}

/** From a session's start, before it sends or recovers its outbox: a thread
 * deleted here forgets its name once the relay has the deletion, even one
 * recovered after a restart, so a refused one keeps it. Only a name saved
 * before the deletion's second goes, so however often or late the deletion is
 * confirmed, a newer name stays. A channel deleted or left here forgets all of
 * its names. */
export function retainThreadTabNames(session: RelaySession) {
  if (!session.viewer) return;
  const { scope } = session;
  session.channelLifecycle?.observeRemoval((channelId) =>
    editNames(scope, (names) => {
      const before = names.size;
      for (const key of names.keys())
        if (key.startsWith(`${channelId}:`)) names.delete(key);
      return names.size !== before;
    }),
  );
  session.outbox?.observeDelivered((event) => {
    const channelId = event.tags.find(([key]) => key === "h")?.[1];
    if (event.kind !== 5 || !channelId) return;
    const deletedAt = event.created_at * 1000;
    editNames(scope, (names) => {
      const before = names.size;
      for (const [key, id] of event.tags) {
        const name = `${channelId}:${id}`;
        if (key === "e" && (saved(names.get(name))?.at ?? 0) < deletedAt)
          names.delete(name);
      }
      return names.size !== before;
    });
  });
}
