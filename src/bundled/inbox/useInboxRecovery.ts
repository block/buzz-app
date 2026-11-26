import type { ChannelList } from "../../features/relay/contracts";
import type { InboxSnapshot } from "../../features/relay/inbox";
import type { InboxFeedSnapshot } from "../../features/relay/inbox-feed";
import type { ReactionFeedSnapshot } from "../../features/relay/inbox-reactions";
import { rosterRecovering } from "../../features/relay/live-recovery";
import {
  useRecoverableRead,
  useRecovery,
  useRecoveryOwns,
} from "../../features/relay/RecoveryNotice";
import type { RelaySession } from "../../features/relay/session";

/** Activity's own passive reads (the conversation roster, unread evidence,
 * the mention feed and the reaction feed) join session recovery, as the rule
 * in recoverable-read.ts asks. A connectivity failure of one is `quiet`: the
 * page and the preview card hide its error and Retry, and recovery retries it
 * on its backoff and at once on reconnect. Denials and other failures stay
 * visible. `held` is true while any read is quiet, so a surface does not claim
 * the list is empty or retained while a read it waits for is still failing. */
export function useInboxRecovery(
  session: RelaySession,
  reads: Readonly<{
    list: ChannelList;
    inbox: InboxSnapshot;
    feed: InboxFeedSnapshot;
    reactions: ReactionFeedSnapshot;
  }>,
) {
  const roster = useRecoveryOwns(session, (live) =>
    rosterRecovering(live.roster),
  );
  const inbox = useRecoverableRead(session.recovery, reads.inbox, () => {
    void session.unread.refresh().catch(() => {});
  });
  const feed = useRecoverableRead(session.recovery, reads.feed, () => {
    void session.inboxFeed.refresh();
  });
  const reactions = useRecoverableRead(
    session.recovery,
    reads.reactions,
    () => {
      void session.inboxFeed.reactions.refresh();
    },
  );
  const { recovering } = useRecovery(session.recovery);
  return {
    /** Session recovery is retrying something. A dropped stream leaves the feeds
     * idle or stale, not failed, until it reconnects and reads them again. The
     * page then hides its Refresh prompts rather than offer a button for it. */
    recovering,
    /** Each source's error, or undefined while recovery owns it. */
    list: roster ? undefined : reads.list.error,
    inbox: inbox.quiet ? undefined : reads.inbox.error,
    feed: feed.quiet ? undefined : reads.feed.error,
    reactions: reactions.quiet ? undefined : reads.reactions.error,
    held:
      (roster && !!reads.list.error) ||
      inbox.quiet ||
      feed.quiet ||
      reactions.quiet,
  };
}
