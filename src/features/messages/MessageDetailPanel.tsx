import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ConversationExtensions } from "../conversation/contracts";
import type { PageNavigation } from "../navigation/service";
import type { RelaySession } from "../relay/session";
import type { MessageDetailView } from "../relay/message-detail";
import { useRowProfiles } from "../relay/react";
import { MessageRow } from "./MessageRow";
import { messageViewKey } from "./view-key";
import { useMessageReveal } from "./use-message-reveal";
import { useReading } from "./use-reading";
import styles from "./Messages.module.css";

type Props = {
  session: RelaySession;
  scope: string;
  channelId: string;
  messageId: string;
  navigation: PageNavigation;
  extensions?: ConversationExtensions | undefined;
  onOpenLink(url: string): boolean;
  canOpenLink?: ((target: string) => boolean) | undefined;
  openChannel(): void;
  retry(): void;
};

/** A bounded exact-target presentation. Normal channel/thread scrolling is independent. */
export function MessageDetailPanel(props: Props) {
  return (
    <OwnedDetail
      key={messageViewKey(
        props.session,
        props.scope,
        props.channelId,
        props.messageId,
      )}
      {...props}
    />
  );
}
function OwnedDetail(props: Props) {
  const { session, channelId, messageId, navigation } = props;
  const [ownedView, setView] = useState<{
    request: PageNavigation;
    view: MessageDetailView;
  }>();
  const view = ownedView?.request === navigation ? ownedView.view : undefined;
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (navigation.signal.aborted) return;
    setError(undefined);
    try {
      const owned = session.messageDetail(channelId, messageId);
      const cancel = () => {
        owned.dispose();
        setView(undefined);
      };
      setView({ request: navigation, view: owned });
      navigation.signal.addEventListener("abort", cancel, { once: true });
      void owned.refresh();
      return () => {
        navigation.signal.removeEventListener("abort", cancel);
        owned.dispose();
      };
    } catch (error) {
      setError(String(error));
      navigation.complete({ status: "failed", reason: "unavailable" });
    }
  }, [session, channelId, messageId, navigation]);
  const failed = useCallback(
    (message: string, missing: boolean) => {
      setError(message);
      navigation.complete({
        status: "failed",
        reason: missing ? "not-found" : "unavailable",
      });
    },
    [navigation],
  );
  return (
    <>
      <div className={styles.threadHistoryControls}>
        <p className={styles.threadNote}>
          Message detail · Selected message only.
        </p>
        <button type="button" onClick={props.openChannel}>
          Open channel
        </button>
      </div>
      {view ? (
        <DetailMessages {...props} view={view} failed={failed} />
      ) : (
        <div className={styles.empty} role={error ? "alert" : "status"}>
          <p>
            {error ??
              (navigation.signal.aborted
                ? "Message opening interrupted."
                : "Locating message…")}
          </p>
          {(error || navigation.signal.aborted) && (
            <button type="button" onClick={props.retry}>
              Retry message
            </button>
          )}
        </div>
      )}
    </>
  );
}
function DetailMessages({
  session,
  channelId,
  messageId,
  navigation,
  extensions,
  onOpenLink,
  canOpenLink,
  view,
  failed,
  retry,
}: Props & {
  view: MessageDetailView;
  failed(message: string, missing: boolean): void;
}) {
  const snapshot = useSyncExternalStore(
    view.subscribe,
    view.snapshot,
    view.snapshot,
  );
  const rows = useMemo(
    () => (snapshot.target ? [snapshot.target] : []),
    [snapshot.target],
  );
  const authors = [
    ...new Set(rows.flatMap((row) => [row.authorId, ...row.mentions])),
  ]
    .sort()
    .join(":");
  useEffect(() => {
    if (authors)
      void session.profiles
        .ensure(authors.split(":"), "background")
        .catch(() => {});
  }, [session.profiles, authors]);
  const profiles = useRowProfiles(session.profiles, rows);
  const scroller = useRef<HTMLElement>(null);
  const settled = useRef(false);
  const complete = useCallback(() => {
    navigation.complete({ status: "opened" });
  }, [navigation]);
  useMessageReveal({
    scroller,
    settled,
    messageId,
    signal: navigation.signal,
    ready: snapshot.status === "ready" && snapshot.target?.id === messageId,
    complete,
  });
  // Opening itself is not mark-read. Reuse focus, visibility and dwell policy.
  useReading({ session, channelId, scroller, settled });
  useEffect(() => {
    if (snapshot.status === "error" || snapshot.status === "unavailable")
      failed(
        snapshot.error ?? "The selected message is missing or deleted.",
        snapshot.status === "unavailable",
      );
  }, [snapshot.status, snapshot.error, failed]);
  return (
    <section
      ref={scroller}
      className={styles.threadHistory}
      aria-label="Message detail"
    >
      {snapshot.target && (
        <MessageRow
          row={snapshot.target}
          extensions={extensions}
          profile={profiles.get(snapshot.target.authorId)}
          participantProfiles={profiles}
          media={session.media}
          onOpenLink={onOpenLink}
          canOpenLink={canOpenLink}
          day={false}
          retry={session.messages.retry}
        />
      )}
      {snapshot.status === "loading" && <p role="status">Locating message…</p>}
      {snapshot.status === "unavailable" && (
        <p role="alert">The selected message is missing or deleted.</p>
      )}
      {snapshot.error && <p role="alert">{snapshot.error}</p>}
      {(snapshot.status === "error" || snapshot.status === "unavailable") && (
        <button type="button" onClick={retry}>
          Retry message
        </button>
      )}
    </section>
  );
}
