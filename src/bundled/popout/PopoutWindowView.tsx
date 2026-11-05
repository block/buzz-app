import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { PopoutAction, PopoutView } from "../../features/popout/window";
import { createReadingProxy } from "../../features/popout/reading-bridge";
import { isBuzzLink } from "../../features/navigation/buzz-links";
import { CompanionRows } from "../../features/companion/CompanionRows";
import { createCompanionReactions } from "../../features/companion/reactions";
import { MessageEditScope } from "../../features/messages/MessageEditScope";
import { Reading } from "../../features/messages/use-reading";
import { useCompanionComposer } from "../huddles/HuddleComposer";
import { huddleComposerExtensions } from "../huddles/composer-extensions";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { ChatCircleIcon } from "../../shared/design-system/icons";
import styles from "./Popout.module.css";

const noSubscription = () => () => {};
const zero = () => 0;

export function PopoutWindowView({
  view,
  act,
  error,
}: {
  view: PopoutView;
  act(action: PopoutAction, text?: string): void;
  error?: string | undefined;
}) {
  const log = useRef<HTMLDivElement>(null);
  const tail = useRef<HTMLDivElement>(null);
  const composerHost = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const settled = useRef(true);
  const [held, setHeld] = useState(false);
  const [confirming, setConfirming] = useState(0);
  const rows = useMemo(
    () => (view.root ? [view.root, ...view.replies] : view.replies),
    [view.root, view.replies],
  );
  const newest = rows.at(-1)?.id;
  useEffect(() => {
    if (newest && following.current)
      tail.current?.scrollIntoView({ block: "end" });
  }, [newest]);
  // Guard state is native-owned until the window is destroyed: the OS close
  // request asks here first while work would be lost.
  useEffect(() => {
    act("guard", held ? "1" : "0");
  }, [act, held]);
  const closeRequested = view.closeRequested ?? 0;
  useEffect(() => {
    if (closeRequested) setConfirming(closeRequested);
  }, [closeRequested]);
  const onHeld = useCallback((value: boolean) => setHeld(value), []);
  // Reply to one message within the thread; cleared when it leaves the view.
  const [replyParent, setReplyParent] = useState<string>();
  const replyTarget = rows.find((row) => row.id === replyParent);
  const replyContext = replyTarget ? (
    <div className={styles.replyContext}>
      <span>Replying to {replyTarget.author}</span>
      <Button size="sm" onClick={() => setReplyParent(undefined)}>
        Cancel
      </Button>
    </div>
  ) : undefined;
  const { composer, client } = useCompanionComposer(
    view.detached ? undefined : view.composer,
    {
      channelName: view.title,
      label: "Reply to thread",
      placeholder: "Reply to thread",
      onHeld,
      replyParentId: replyTarget?.id,
      replyContext,
    },
  );
  // Reactions and the picker use the same bridge as the composer: one owner
  // in main admits them against the rows this window shows.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useSyncExternalStore(
    client?.subscribe ?? noSubscription,
    client?.revision ?? zero,
  );
  const bridgeSession = client?.snapshot().session;
  const toolKeys = JSON.stringify(client?.snapshot().data?.tools ?? []);
  const reactions = useMemo(() => {
    if (!client || !bridgeSession) return undefined;
    const session = createCompanionReactions(
      bridgeSession,
      client,
      (eventId) =>
        rowsRef.current.find((row) =>
          row.reactions?.some((group) =>
            group.events.some((event) => event.id === eventId),
          ),
        )?.id,
    );
    const extensions = huddleComposerExtensions({
      tools: JSON.parse(toolKeys) as string[],
      completions: [],
      gifRequests: client.gifs,
    });
    return { session, tools: extensions.tools, inline: extensions.inline };
  }, [client, bridgeSession, toolKeys]);
  useEffect(() => () => reactions?.session.dispose(), [reactions]);
  // Main's own reaction operations ride the view: delivery, failure, retry.
  const mainOperations = view.reactionOperations;
  useEffect(() => {
    reactions?.session.setMainOperations(mainOperations);
  }, [reactions, mainOperations]);
  const focusConversation = () => {
    const editor = composerHost.current?.querySelector<HTMLElement>(
      '[role="textbox"]:not([aria-disabled="true"]), textarea:not(:disabled)',
    );
    (editor ?? log.current)?.focus({ preventScroll: true });
  };
  const readingToken = view.detached ? undefined : view.reading;
  const readingRevision = useRef(view.readingRevision);
  readingRevision.current = view.readingRevision;
  const [readingSession, setReadingSession] =
    useState<ReturnType<typeof createReadingProxy>>();
  useEffect(() => {
    if (!readingToken) {
      setReadingSession(undefined);
      return;
    }
    const proxy = createReadingProxy(
      readingToken,
      () => true,
      () => readingRevision.current,
    );
    setReadingSession(proxy);
    return () => proxy.dispose();
  }, [readingToken]);
  return (
    <MessageEditScope>
      <div className={styles.window} data-reading-surface="">
        {view.detached && (
          <p role="status" className={styles.notice}>
            Buzz is reconnecting. This window shows what it last received.
          </p>
        )}
        {error && (
          <p role="alert" className={styles.notice}>
            {error}
          </p>
        )}
        <div
          ref={log}
          tabIndex={-1}
          className={styles.messages}
          role="log"
          aria-label="Thread messages"
          onScroll={(e) => {
            const el = e.currentTarget;
            following.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          }}
        >
          {readingSession && view.root && (
            <Reading
              session={readingSession}
              channelId={view.root.channelId}
              latestMessageId={newest}
              rootId={view.root.id}
              scroller={log}
              settled={settled}
            />
          )}
          {view.limited && (
            <p className={styles.notice}>Showing the latest 500 replies.</p>
          )}
          {view.canLoadMore && (
            <Button
              size="sm"
              disabled={view.loadingOlder}
              onClick={() => act("older")}
            >
              {view.loadingOlder ? "Loading…" : "Load earlier replies"}
            </Button>
          )}
          {!rows.length &&
            (view.status === "loading" ? (
              <p className={styles.notice} role="status">
                Loading thread…
              </p>
            ) : view.status === "ready" && !view.error ? (
              <EmptyState icon={<ChatCircleIcon />} title="No messages yet" />
            ) : null)}
          <CompanionRows
            rows={rows}
            writable={view.writable}
            allowImageCopy={false}
            capabilities={{
              reactions,
              scope: view.scope,
              onReply: (messageId) => {
                setReplyParent(messageId);
                focusConversation();
              },
            }}
            openLink={(url) => {
              // Buzz targets continue in main; the OS browser takes the rest.
              if (!isBuzzLink(url)) return false;
              act("openLink", url);
              return true;
            }}
            recover={(id, dismiss) =>
              act(dismiss ? "discardMessage" : "retryMessage", id)
            }
            focusConversation={focusConversation}
          />
          <div ref={tail} />
        </div>
        {view.error && (
          <div role="alert" className={styles.notice}>
            {view.error}{" "}
            <Button
              size="sm"
              onClick={() => {
                log.current?.focus({ preventScroll: true });
                act("retry");
              }}
            >
              Retry
            </Button>
          </div>
        )}
        {view.writable && !view.detached ? (
          <div ref={composerHost} className={styles.composer}>
            {composer}
          </div>
        ) : (
          !view.detached && (
            <p className={styles.notice} role="status">
              {view.status === "ready" && !view.error
                ? "This thread is read-only here."
                : "Connecting to this thread…"}
            </p>
          )
        )}
        {confirming > 0 && (
          <AlertDialog
            title="Close this window?"
            description="This window holds a reply that isn’t saved yet. Closing it discards that work."
            onClose={() => setConfirming(0)}
            actions={
              <>
                <Button onClick={() => setConfirming(0)}>Keep editing</Button>
                <Button variant="destructive" onClick={() => act("close")}>
                  Close window
                </Button>
              </>
            }
          />
        )}
      </div>
    </MessageEditScope>
  );
}
