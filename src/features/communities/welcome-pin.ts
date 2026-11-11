import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { SnapshotRead } from "../agents/agent-config-artifacts";
import { earlierActivityFilter } from "../relay/earlier-activity";
import { splitPartition } from "../relay/partition";
import {
  clearViewScope,
  readView,
  replaceView,
  subscribeView,
  writeView,
} from "../../shared/view-state";

/** A newcomer's own events from the minutes before this device first opened
 * the community, such as a profile set up while joining, still count as new. */
export const WELCOME_GRACE_SECONDS = 600;
/** View key, scoped by relay alone (every identity on this device): unix
 * seconds when this device first opened the community in Messages. */
export const WELCOME_FIRST_OPEN_KEY = "welcome-first-open";
/** View key, scoped by relay and viewer: whether the relay had an event by the
 * viewer from before {@link WELCOME_FIRST_OPEN_KEY} less the grace period. */
export const WELCOME_EARLIER_ACTIVITY_KEY = "welcome-earlier-activity";
/** View key, scoped by relay alone: this welcome channel's card was dismissed.
 * A welcome moved to another channel is a new welcome, with its own key. */
export const welcomeDismissedKey = (channelId: string) =>
  `welcome-dismissed:${channelId}`;
/** Every welcome key scoped by relay alone starts with this. */
const WELCOME_KEY_PREFIX = "welcome-";

const origin = (scope: string) => splitPartition(scope)?.communityOrigin;
const unscoped = () => () => {};

/** Records when this device first opened the community of the relay session
 * `scope`, unless it has before. An existing install records its first open
 * after upgrading. */
export function recordWelcomeFirstOpen(scope: string, now = Date.now()) {
  const relay = origin(scope);
  if (relay)
    replaceView(relay, WELCOME_FIRST_OPEN_KEY, null, Math.floor(now / 1000));
}

/** Forgets the welcome state this device keeps for the community at `origin`
 * across its identities: the first open and every dismissal. A later rejoin
 * records a fresh first open; the relay's answer still classes a member with
 * older events as existing. */
export function forgetWelcome(origin: string) {
  clearViewScope(origin, WELCOME_KEY_PREFIX);
}

/**
 * Whether the welcome channel `channelId` shows its pinned welcome to this
 * viewer, who must be a member of it (`member`): only while this device has a
 * first-open time for the community, the card has not been dismissed here, and
 * the relay has no event by the viewer from before that time less
 * {@link WELCOME_GRACE_SECONDS}. One read answers that, once per relay and
 * viewer on this device. Nothing shows while it is pending, and a failed read
 * is not an answer: nothing is kept and the next visit asks again.
 */
export function usePinnedWelcome({
  session,
  scope,
  channelId,
  member,
}: {
  session: Readonly<{
    viewer?: string | undefined;
    snapshotRead?: SnapshotRead | undefined;
  }>;
  /** The relay session's partition. */
  scope: string;
  channelId: string | undefined;
  member: boolean;
}) {
  const relay = origin(scope);
  const { viewer, snapshotRead: read } = session;
  const dismissKey = channelId && welcomeDismissedKey(channelId);
  const dismissed = useSyncExternalStore(
    useCallback(
      (listener: () => void) =>
        relay ? subscribeView(relay, listener) : unscoped(),
      [relay],
    ),
    // Messages renders on every list change; read storage only when it counts.
    () =>
      member &&
      !!relay &&
      !!dismissKey &&
      readView<unknown>(relay, dismissKey, false) === true,
  );
  // Hides at once even if storage cannot keep the dismissal.
  const [closed, setClosed] = useState<string>();
  const asking =
    member && !!channelId && !dismissed && closed !== channelId && !!relay;
  // A kept answer is read during render, so a card it allows is in the first
  // commit with the channel, not one commit after it painted.
  const kept = useSyncExternalStore(
    useCallback(
      (listener: () => void) => subscribeView(scope, listener),
      [scope],
    ),
    () => {
      if (!asking) return undefined;
      const value = readView<unknown>(
        scope,
        WELCOME_EARLIER_ACTIVITY_KEY,
        undefined,
      );
      return typeof value === "boolean" ? value : undefined;
    },
  );
  // The relay's answer when storage could not keep it.
  const [answer, setAnswer] = useState<{ scope: string; earlier: boolean }>();
  const earlier =
    kept ?? (answer?.scope === scope ? answer.earlier : undefined);
  const answered = earlier !== undefined;
  useEffect(() => {
    if (!asking || answered || !relay || !viewer) return;
    const firstOpen = readView<unknown>(relay, WELCOME_FIRST_OPEN_KEY, null);
    if (
      !read ||
      typeof firstOpen !== "number" ||
      !Number.isSafeInteger(firstOpen)
    )
      return;
    const controller = new AbortController();
    read([earlierActivityFilter(viewer, firstOpen - WELCOME_GRACE_SECONDS)], {
      signal: controller.signal,
    }).then(
      (events) => {
        if (controller.signal.aborted) return;
        const earlier = events.length > 0;
        writeView(scope, WELCOME_EARLIER_ACTIVITY_KEY, earlier);
        setAnswer({ scope, earlier });
      },
      () => {
        // Offline, refused or timed out proves nothing about this member.
      },
    );
    return () => controller.abort();
  }, [asking, answered, relay, scope, viewer, read]);
  const dismiss = useCallback(() => {
    if (!relay || !dismissKey || !channelId) return;
    setClosed(channelId);
    writeView(relay, dismissKey, true);
  }, [relay, dismissKey, channelId]);
  return {
    shown: asking && earlier === false,
    dismiss,
  };
}
