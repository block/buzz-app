import { useMemo, useRef, useSyncExternalStore } from "react";
import { needsYouChannels } from "../../features/relay/inbox";
import type { RelaySession } from "../../features/relay/session";
import {
  readView,
  subscribeView,
  viewRevision,
  writeView,
} from "../../shared/view-state";

const unreadsFirstKey = "sidebar:unreads-first";
const noSubscription = () => () => {};

/** Cards where unreads stay in place; every other card shows them first. */
function savedOff(scope: string): Record<string, false> {
  const saved = readView<unknown>(scope, unreadsFirstKey, {});
  return saved && typeof saved === "object" && !Array.isArray(saved)
    ? Object.fromEntries(
        Object.entries(saved).filter(
          (entry): entry is [string, false] => entry[1] === false,
        ),
      )
    : {};
}

/**
 * Whether each card shows its unreads first, remembered on this device like
 * its height and display. On unless turned off; without a scope, always on.
 */
export function useSidebarUnreadsFirst(scope: string | undefined) {
  const revision = useSyncExternalStore(
    scope ? (change) => subscribeView(scope, change) : noSubscription,
    () => (scope ? viewRevision(scope, unreadsFirstKey) : undefined),
  );
  return useMemo(() => {
    const off = scope && revision ? savedOff(scope) : {};
    return (card: string) => off[card] !== false;
  }, [scope, revision]);
}

export function setSidebarUnreadsFirst(
  scope: string,
  card: string,
  on: boolean,
) {
  const { [card]: _, ...rest } = savedOff(scope);
  writeView(scope, unreadsFirstKey, on ? rest : { ...rest, [card]: false });
}

/**
 * Conversations that wait on you move to the top, each group keeping the
 * card's own order. Returns the same rows when nothing moves.
 */
export function unreadsFirst<T>(
  rows: readonly T[],
  waiting: ReadonlySet<string>,
  id: (row: T) => string,
): readonly T[] {
  if (!waiting.size) return rows;
  const first: T[] = [];
  const rest: T[] = [];
  for (const row of rows) (waiting.has(id(row)) ? first : rest).push(row);
  return first.every((row, index) => rows[index] === row)
    ? rows
    : [...first, ...rest];
}

/**
 * Unmuted conversations that need you (see `needsYou`). The one you open stays
 * in the set until you leave it, so reading it doesn't pull it out from under
 * you.
 */
export function useWaitingChannels(
  unread: RelaySession["unread"],
  muted: readonly string[] | undefined,
  open: string | undefined,
) {
  const inbox = useSyncExternalStore(
    unread.subscribeInbox,
    () => unread.inbox(),
    () => unread.inbox(),
  );
  const held = useRef<{ open: string | undefined; held: boolean }>({
    open: undefined,
    held: false,
  });
  return useMemo(() => {
    const quiet = new Set(muted ?? []);
    const waiting = new Set(
      [...needsYouChannels(inbox)].filter((id) => !quiet.has(id)),
    );
    if (held.current.open !== open)
      held.current = { open, held: !!open && waiting.has(open) };
    if (open && held.current.held) waiting.add(open);
    return waiting;
  }, [inbox, muted, open]);
}
