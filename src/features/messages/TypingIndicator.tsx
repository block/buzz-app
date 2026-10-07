import { useChannelIdentityNames } from "../identity-names/react";
import { useSyncExternalStore } from "react";
import { activityTarget } from "../agents/activity-target";
import type { RelaySession } from "../relay/session";
import styles from "./TypingIndicator.module.css";

const noSubscribe = () => () => {};
const noActivity = () => undefined;

/** Shared presentation only. Mounting more consumers creates no relay work. */
export function TypingIndicator({
  session,
  channelId,
  threadRootId,
  canOpenActivity,
}: {
  session: RelaySession;
  channelId: string;
  threadRootId?: string | undefined;
  canOpenActivity?: ((target: string) => boolean) | undefined;
}) {
  const entries = useSyncExternalStore(
    session.typing.subscribe,
    session.typing.snapshot,
  );
  const activity = useSyncExternalStore(
    session.agentActivity?.subscribe ?? noSubscribe,
    session.agentActivity?.snapshot ?? noActivity,
  );
  const resolveName = useChannelIdentityNames(session, channelId);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const matching = entries.filter(
    (entry) =>
      entry.channelId === channelId &&
      entry.threadRootId === threadRootId &&
      // The existing activity accessory already presents these exact identities.
      // Keep public typing when that activity action is unavailable or disabled.
      !activity?.typing.some(
        (agent) =>
          agent.channelId === channelId &&
          agent.threadRootId === threadRootId &&
          agent.agent === entry.pubkey &&
          canOpenActivity?.(activityTarget(agent.agent, channelId)),
      ),
  );
  if (!matching.length) return null;
  // Reuse already available names; optional typing must not trigger profile reads.
  const names = matching
    .slice(0, 3)
    .map(({ pubkey }) =>
      resolveName(pubkey, profiles.get(pubkey)?.name ?? pubkey.slice(0, 10)),
    );
  const others = matching.length - names.length;
  return (
    <div className={styles.typing} role="status" aria-label="Typing activity">
      <span className={styles.dots} aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className={styles.label}>
        <span className={styles.names}>{names.join(", ")}</span>
        {others > 0 ? ` and ${others} others` : ""}
        {matching.length === 1 ? " is typing" : " are typing"}
      </span>
    </div>
  );
}
