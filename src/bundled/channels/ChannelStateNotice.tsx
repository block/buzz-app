import type { ReactNode } from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import { Button } from "../../shared/design-system/ui/Button";
import { useLifecycleOffer, type LifecycleSession } from "./useLifecycleOffer";
import styles from "./ChannelStateNotice.module.css";

/** The pane's notice slot. It stays mounted, so a notice that appears while
 * a channel is open, such as removal, lands in an existing live region and is
 * announced; a status mounted with its content may not be. */
export function ChannelStateRegion({ children }: { children?: ReactNode }) {
  return (
    <div aria-live="polite" className={styles.region}>
      {children}
    </div>
  );
}

/** A lasting state of the open channel, named at the top of its pane, above
 * the history it affects. The lower composer notice says what that state does
 * to writing; this one says what the channel is and what can change it. */
export function ChannelStateNotice({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string | undefined;
  /** At most one small action. */
  children?: ReactNode;
}) {
  return (
    <section role="status" aria-label={title} className={styles.notice}>
      <div className={styles.message}>
        <p className="text-label-sm">{title}</p>
        {detail && <p className="text-body-sm text-subtle">{detail}</p>}
      </div>
      {children}
    </section>
  );
}

/** Archived channels stay readable; owners and admins can restore them here.
 * The offer comes from live channel state; confirmation rechecks the relay. */
export function ArchivedChannelNotice({
  channel,
  session,
  unarchive,
}: {
  channel: ChannelSummary;
  session: LifecycleSession;
  unarchive(trigger: HTMLElement): void;
}) {
  const offer = useLifecycleOffer(session, channel);
  return (
    <ChannelStateNotice
      title="Archived · view only"
      detail="It’s hidden from the sidebar until it’s unarchived."
    >
      {offer?.canUnarchive && session.channelLifecycle.available && (
        <Button
          type="button"
          size="sm"
          onClick={(event) => unarchive(event.currentTarget)}
        >
          Unarchive
        </Button>
      )}
    </ChannelStateNotice>
  );
}
