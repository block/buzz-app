import type { RelaySession } from "../relay/session";
import type { UnreadSnapshot } from "../relay/unread";

type PreferencesSnapshot = ReturnType<
  RelaySession["sidebarPreferences"]["snapshot"]
>;

/** Only confirmed preferences count; optimistic menu intents do not quiet unread. */
export function confirmedMute(
  preferences: PreferencesSnapshot,
  channelId: string,
) {
  return !preferences.cached && !!preferences.data?.muted.includes(channelId);
}

/** A row's unread state: mute quiets ordinary backlog, never manual unread or attention. */
export function channelUnread(snapshot: UnreadSnapshot, muted: boolean) {
  return (
    snapshot.manual !== "none" ||
    ((snapshot.observedCount ?? 0) > 0 &&
      (!muted || (snapshot.attentionCount ?? 0) > 0))
  );
}
