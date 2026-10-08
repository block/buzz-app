import { TypingDots } from "../../shared/design-system/ui/TypingDots";
import { useReplacedTypers } from "../conversation/typing-presentation";
import { useChannelIdentityNames } from "../identity-names/react";
import { useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import styles from "./TypingIndicator.module.css";

/** Shared presentation only. Mounting more consumers creates no relay work. */
export function TypingIndicator({
  session,
  channelId,
  threadRootId,
}: {
  session: RelaySession;
  channelId: string;
  threadRootId?: string | undefined;
}) {
  const entries = useSyncExternalStore(
    session.typing.subscribe,
    session.typing.snapshot,
  );
  const resolveName = useChannelIdentityNames(session, channelId);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const replaced = useReplacedTypers(session, channelId, threadRootId);
  const matching = entries.filter(
    (entry) =>
      entry.channelId === channelId &&
      entry.threadRootId === threadRootId &&
      !replaced.has(entry.pubkey),
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
      <TypingDots />
      <span className={styles.label}>
        <span className={styles.names}>{names.join(", ")}</span>
        {others > 0 ? ` and ${others} others` : ""}
        {matching.length === 1 ? " is typing" : " are typing"}
      </span>
    </div>
  );
}
