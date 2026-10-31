import type { NamingIdentity } from "./policy";
import { useSyncExternalStore, useCallback, useMemo } from "react";
import { useListedChannel } from "../relay/listed-channel";
import type { RelaySession } from "../relay/session";
import type { IdentityNameView } from "./service";
const zero = () => 0;
const watched = 500;
/** The interface arrives through the captured session, never a global lookup. */
export function useIdentityNames(names: IdentityNameView | undefined) {
  // Re-render only when a label this component resolved changes: one arriving
  // profile should not repaint every name on screen.
  const store = useMemo(() => {
    type Args = Parameters<IdentityNameView["resolve"]>;
    const shown = new Map<string, { args: Args; label: string | undefined }>();
    const ids = new WeakMap<object, number>();
    let next = 0;
    const id = (value: object | undefined) => {
      if (!value) return 0;
      if (!ids.has(value)) ids.set(value, ++next);
      return ids.get(value);
    };
    let revision = 0;
    let overflow = false;
    let seen = names?.snapshot();
    // A changed label, or too many to watch, re-renders and starts over.
    const refresh = () => {
      if (
        !overflow &&
        [...shown.values()].every(
          ({ args, label }) => names?.resolve(...args) === label,
        )
      )
        return false;
      shown.clear();
      overflow = false;
      revision++;
      return true;
    };
    return {
      show(args: Args, label: string | undefined) {
        if (!names) return;
        const [pubkey, fallback, candidates, displayFacts] = args;
        seen = names?.snapshot();
        const key = `${pubkey}\n${fallback}\n${id(candidates)}\n${id(displayFacts)}`;
        if (shown.has(key) || shown.size < watched)
          shown.set(key, { args, label });
        else overflow = true;
      },
      subscribe(listener: () => void) {
        if (!names) return () => {};
        const stop = names.subscribe(() => {
          if (refresh()) listener();
        });
        // A change between render and subscribe.
        if (names.snapshot() !== seen && refresh()) listener();
        return stop;
      },
      snapshot: () => revision,
    };
  }, [names]);
  const revision = useSyncExternalStore(store.subscribe, store.snapshot, zero);
  return useCallback(
    (
      pubkey: string,
      fallback: string,
      candidates?: readonly string[],
      displayFacts?: readonly NamingIdentity[],
    ): string => {
      // Invalidate memoized labels and completion choices on name changes.
      void revision;
      const label = names?.resolve(pubkey, fallback, candidates, displayFacts);
      store.show([pubkey, fallback, candidates, displayFacts], label);
      return label ?? fallback;
    },
    [names, store, revision],
  );
}

const noMembers: readonly string[] = [];
/** Channel membership defines ambiguity, not the community-wide profile cache. */
export function useChannelIdentityNames(
  session:
    | {
        names?: IdentityNameView | undefined;
        channels: Pick<RelaySession["channels"], "list" | "subscribeList">;
      }
    | undefined,
  channelId: string | undefined,
) {
  const members = useListedChannel(
    session?.channels,
    channelId,
    (channel) => channel?.members ?? noMembers,
  );
  const resolve = useIdentityNames(session?.names);
  return useCallback(
    (pubkey: string, fallback: string) => resolve(pubkey, fallback, members),
    [resolve, members],
  );
}
