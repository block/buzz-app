import { useCallback, useSyncExternalStore } from "react";
import { type NeedsYou, needsYou, nothingNeedsYou } from "./inbox";
import type { RelaySession } from "./session";

/** Observe only confirmed preferences; optimistic menu intents do not quiet unread. */
export function useConfirmedMute(session: RelaySession, channelId: string) {
  const get = useCallback(() => {
    const snapshot = session.sidebarPreferences.snapshot();
    return !snapshot.cached && !!snapshot.data?.muted.includes(channelId);
  }, [session, channelId]);
  return useSyncExternalStore(session.sidebarPreferences.subscribe, get, get);
}

/**
 * Whether a conversation needs you (see `needsYou`), quiet while it is muted.
 * Every sidebar unread cue reads this: counts, dots, ordering and scroll cues.
 */
export function useNeedsYou(
  session: RelaySession,
  channelId: string,
): NeedsYou {
  const muted = useConfirmedMute(session, channelId);
  const get = useCallback(
    () => needsYou(session.unread.inbox(), channelId),
    [session, channelId],
  );
  const needs = useSyncExternalStore(session.unread.subscribeInbox, get, get);
  return muted ? nothingNeedsYou : needs;
}
