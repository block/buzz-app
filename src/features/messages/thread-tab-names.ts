import type { RelaySession } from "../relay/session";
import { readView, writeView } from "../../shared/view-state";

// Thread tab names are durable view intent for an account/community, unlike
// the tab layout: a thread's tab takes its name again when it reopens after a
// restart. One record keeps the 256 newest names, keyed `<channel>:<root>`,
// "" for a cleared one, oldest first. The bundled tab store reads and writes
// them; the session forgets them when a thread or channel goes, and leaving
// the community clears them with its other view state.
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

/** A thread's saved name, "" once cleared, or undefined if never named. */
export function readThreadTabName(scope: string, key: string) {
  const name = savedNames(scope).get(key);
  return typeof name === "string" ? name : undefined;
}
/** Saves a name as the newest; undefined forgets it. */
export function saveThreadTabName(
  scope: string,
  key: string,
  name: string | undefined,
) {
  editNames(scope, (names) => {
    const existed = names.delete(key);
    if (name !== undefined) names.set(key, name);
    return existed || name !== undefined;
  });
}

/** From a session's start, before it sends or recovers its outbox: a thread
 * deleted here forgets its name once the relay has the deletion, even one
 * recovered after a restart, so a refused one keeps it. A channel deleted or
 * left here forgets all of its names. */
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
    for (const [key, id] of event.tags)
      if (key === "e" && id)
        saveThreadTabName(scope, `${channelId}:${id}`, undefined);
  });
}
