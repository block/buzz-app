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
import { createCompanionOperations } from "../../features/companion/operations";
import { toMessage } from "../../features/companion/CompanionManagementItems";
import type { CompanionRow } from "../../features/companion/row";
import { ReportMessageDialog } from "../../features/messages/ReportMessageDialog";
import { MessageEditScope } from "../../features/messages/MessageEditScope";
import { Reading } from "../../features/messages/use-reading";
import { useCompanionComposer } from "../huddles/HuddleComposer";
import { huddleComposerExtensions } from "../huddles/composer-extensions";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import {
  CaretLeftIcon,
  ChatCircleIcon,
  HashIcon,
  LockIcon,
  MessageReplyIcon,
  RobotIcon,
  UsersIcon,
} from "../../shared/design-system/icons";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import { SurfaceButton } from "../../shared/design-system/ui/SurfaceButton";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import styles from "./Popout.module.css";

const noSubscription = () => () => {};
const zero = () => 0;
const none: readonly import("../../features/relay/outbox").OutgoingEvent[] = [];
const noOperations = () => none;

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
  // A voice note being captured is lost when its editor unmounts, which
  // changing frames does; navigation asks first while one is in progress.
  const [capturing, setCapturing] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<
    { action: "openThread"; rootId: string } | { action: "back" }
  >();
  const navigate = (
    next: { action: "openThread"; rootId: string } | { action: "back" },
  ) => {
    if (capturing) {
      setPendingNavigation(next);
      return;
    }
    if (next.action === "openThread") act("openThread", next.rootId);
    else act("back");
  };
  const rows = useMemo(
    () => (view.root ? [view.root, ...view.replies] : view.replies),
    [view.root, view.replies],
  );
  // Named as the tab strip names it: `#` only where the icon is a hash.
  const conversation = view.kind === "channel" ? `#${view.title}` : view.title;
  const kindLabel = {
    channel: "Public channel",
    private: "Private channel",
    dm: "Direct message",
    solo: "Solo chat",
  }[view.kind];
  // Main's header identity: the member stack opens the access dialog there.
  const members = view.members;
  const membersLabel = members
    ? members.solo
      ? `${members.count} ${members.count === 1 ? "agent" : "agents"} in ${view.title}; opens in the main window`
      : `${members.count} ${members.count === 1 ? "member" : "members"} of ${conversation}; opens in the main window`
    : undefined;
  // Main's own words for who is working and typing here.
  const typingText = view.typing
    ? [
        view.typing.agents.length
          ? `${view.typing.agents.join(", ")}${view.typing.agents.length === 1 ? " is working" : " are working"}`
          : "",
        view.typing.humans.length
          ? `${view.typing.humans.join(", ")}${view.typing.more ? ` and ${view.typing.more} others` : ""}${view.typing.humans.length + view.typing.more === 1 ? " is typing" : " are typing"}`
          : "",
      ]
        .filter(Boolean)
        .join(". ")
    : "";
  // Companion wording follows the frame: a thread's replies or a
  // conversation's messages.
  const what = view.thread ? "thread" : "conversation";
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
  const [operationsSession, setOperationsSession] =
    useState<ReturnType<typeof createCompanionOperations>>();
  // Editable rows carry main's exact baseline for the shared edit flow.
  const editMessages = useMemo(
    () => rows.filter((row) => row.editable).map(toMessage),
    [rows],
  );
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
      label: view.thread ? "Reply to thread" : `Message ${conversation}`,
      placeholder: view.thread ? "Reply to thread" : `Message ${conversation}`,
      onHeld,
      replyParentId: replyTarget?.id,
      replyContext,
      editMessages,
      // The operations session is built from the client below; one render
      // after it exists the editor adopts it (edits then follow one id).
      session: operationsSession,
      // Voice notes record here; main uploads them like any attachment.
      capture: true,
      onCapturing: setCapturing,
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
  const toolKeys = JSON.stringify([
    client?.snapshot().data?.tools ?? [],
    client?.snapshot().data?.links ?? [],
  ]);
  const reactions = useMemo(() => {
    if (!client || !bridgeSession) return undefined;
    const session = createCompanionOperations(bridgeSession, client, {
      messageOf: (eventId) =>
        rowsRef.current.find((row) =>
          row.reactions?.some((group) =>
            group.events.some((event) => event.id === eventId),
          ),
        )?.id,
      sourceOf: (messageId) => {
        const row = rowsRef.current.find((row) => row.id === messageId);
        return row?.editable?.sourceContent ?? row?.text;
      },
    });
    const [tools, links] = JSON.parse(toolKeys) as [string[], string[]];
    const extensions = huddleComposerExtensions({
      tools,
      completions: [],
      links,
      gifRequests: client.gifs,
    });
    return {
      session,
      tools: extensions.tools,
      inline: extensions.inline,
      links: extensions.links,
    };
  }, [client, bridgeSession, toolKeys]);
  useEffect(() => {
    setOperationsSession(reactions?.session);
    return () => reactions?.session.dispose();
  }, [reactions]);
  // Main's own operations ride the view: delivery, failure, retry.
  const mainOperations = view.operations;
  const mainVersion = view.version;
  useEffect(() => {
    reactions?.session.setMainOperations(mainOperations, mainVersion);
  }, [reactions, mainOperations, mainVersion]);
  const operations = useSyncExternalStore(
    reactions?.session.outbox?.subscribe ?? noSubscription,
    reactions?.session.outbox?.snapshot ?? noOperations,
  );
  const [deleting, setDeleting] = useState<{
    row: CompanionRow;
    operationId?: string;
  }>();
  const [reporting, setReporting] = useState<CompanionRow>();
  const [managementError, setManagementError] = useState<string>();
  const ask = useCallback((work: () => Promise<unknown>) => {
    setManagementError(undefined);
    work().catch((cause: unknown) =>
      setManagementError(
        cause instanceof Error ? cause.message : "Couldn’t complete that.",
      ),
    );
  }, []);
  const management = useMemo(() => {
    if (!client || !reactions) return undefined;
    const session = reactions.session;
    return {
      following: view.following,
      isDm: view.isDm,
      busy: (messageId: string) =>
        operations.some(
          (item) =>
            ["sending", "failed", "unknown"].includes(item.delivery) &&
            session.messages.reactionTarget(item.event) === messageId &&
            (item.event.kind === 5 || item.event.kind === 40003),
        ),
      deleteMessage: (row: CompanionRow) => setDeleting({ row }),
      sendToChannel: (row: CompanionRow) => {
        try {
          session.messages.sendToChannel(row.id);
        } catch (cause) {
          setManagementError(
            cause instanceof Error ? cause.message : "Couldn’t send.",
          );
        }
      },
      markRead: (row: CompanionRow, unread: boolean) =>
        ask(() => client.markRead({ messageId: row.id, unread })),
      follow: (following: boolean) => ask(() => client.follow({ following })),
      report: (row: CompanionRow) => setReporting(row),
      // Main admits the handoff, then this window brings main forward so
      // the action opens where the user is looking.
      handoff: (row: CompanionRow, action: { key: string; revision: string }) =>
        ask(async () => {
          await client.handoff({
            messageId: row.id,
            key: action.key,
            revision: action.revision,
          });
          act("focusMain");
        }),
    };
  }, [client, reactions, view.following, view.isDm, operations, ask, act]);
  const deleteOperation = deleting?.operationId
    ? operations.find((item) => item.event.id === deleting.operationId)
    : undefined;
  useEffect(() => {
    // Delivered (or gone from main after admission): the dialog's work is done.
    if (
      deleting?.operationId &&
      (!deleteOperation ||
        deleteOperation.delivery === "accepted" ||
        deleteOperation.delivery === "seen")
    )
      setDeleting(undefined);
  }, [deleting, deleteOperation]);

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
        {/* As Slack's pop-out: what this window is, and of which conversation;
            a frame opened from the conversation offers the way back to it. */}
        <header className={styles.header}>
          {view.canGoBack && (
            <IconButton
              hint="familiar"
              aria-label="Back to conversation"
              title="Back"
              icon={<CaretLeftIcon />}
              onClick={() => navigate({ action: "back" })}
            />
          )}
          {/* The same icon the main window's tab shows for this conversation
              (a thread frame shows the thread mark), so the kind is read at a
              glance where the name alone does not say it (DM, Solo). */}
          <span
            className={styles.icon}
            role="img"
            aria-label={view.thread ? "Thread" : kindLabel}
            data-kind={view.thread ? "thread" : view.kind}
          >
            {view.thread ? (
              <MessageReplyIcon size="1rem" />
            ) : view.kind === "dm" ? (
              <Avatar
                alt=""
                fallback={view.title}
                size="fill"
                src={view.picture ?? undefined}
              />
            ) : view.kind === "private" ? (
              <LockIcon size="1rem" />
            ) : view.kind === "solo" ? (
              <ChatCircleIcon size="1rem" />
            ) : (
              <HashIcon size="1rem" />
            )}
          </span>
          <h1 className={styles.title}>
            {view.thread ? (
              <>
                <span className={styles.kind}>Thread</span>{" "}
                <span className={styles.conversation}>{conversation}</span>
              </>
            ) : (
              <span className={styles.kind}>{conversation}</span>
            )}
          </h1>
          {members && (
            <SurfaceButton
              className={styles.members}
              aria-label={membersLabel}
              title={members.solo ? "Agents" : "Members"}
              onClick={() => act("openMembers")}
            >
              {members.preview.length ? (
                <AvatarStack
                  size="small"
                  max={3}
                  items={[
                    ...members.preview.map((person) => ({
                      id: person.id,
                      name: person.name,
                      src: person.picture ?? undefined,
                      shape: members.solo
                        ? ("squircle" as const)
                        : ("circle" as const),
                    })),
                    // Members past the shown ones only count.
                    ...Array.from(
                      {
                        length: Math.max(
                          0,
                          Math.min(members.count, 1000) -
                            members.preview.length,
                        ),
                      },
                      (_, index) => ({
                        id: `more-${index}`,
                        name: "",
                        shape: members.solo
                          ? ("squircle" as const)
                          : ("circle" as const),
                      }),
                    ),
                  ]}
                />
              ) : (
                <Avatar
                  size="small"
                  shape="circle"
                  alt=""
                  fallback={members.solo ? "Agents" : "Members"}
                  fallbackContent={
                    members.solo ? (
                      <RobotIcon size="1rem" aria-hidden="true" />
                    ) : (
                      <UsersIcon size="1rem" aria-hidden="true" />
                    )
                  }
                />
              )}
            </SurfaceButton>
          )}
        </header>
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
          aria-label={view.thread ? "Thread messages" : "Messages"}
          onScroll={(e) => {
            const el = e.currentTarget;
            following.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          }}
        >
          {readingSession && rows[0] && (
            <Reading
              session={readingSession}
              channelId={rows[0].channelId}
              latestMessageId={newest}
              rootId={view.thread ? view.root?.id : undefined}
              scroller={log}
              settled={settled}
            />
          )}
          {view.limited && (
            <p className={styles.notice}>
              Showing the latest 500 {view.thread ? "replies" : "messages"}.
            </p>
          )}
          {view.canLoadMore && (
            <Button
              size="sm"
              disabled={view.loadingOlder}
              onClick={() => act("older")}
            >
              {view.loadingOlder
                ? "Loading…"
                : `Load earlier ${view.thread ? "replies" : "messages"}`}
            </Button>
          )}
          {!rows.length &&
            (view.status === "loading" ? (
              <p className={styles.notice} role="status">
                Loading {what}…
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
              management,
              // A conversation drills into one of its threads here, in this
              // window; main re-points the projection and keeps the way back.
              onOpenThread: view.thread
                ? undefined
                : (rootId) => navigate({ action: "openThread", rootId }),
            }}
            layout={view.thread ? "thread" : "timeline"}
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
          {typingText && (
            <p
              role="status"
              aria-live="polite"
              className={styles.typing}
              data-conversation-activity=""
            >
              {typingText}
            </p>
          )}
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
                ? `This ${what} is read-only here.`
                : `Connecting to this ${what}…`}
            </p>
          )
        )}
        {managementError && (
          <p role="alert" className={styles.notice}>
            {managementError}
          </p>
        )}
        {deleting && reactions && (
          <AlertDialog
            title="Delete message?"
            description="This requests removal of this message from Buzz’s relay. People may still have copies. This cannot be undone."
            pending={deleteOperation?.delivery === "sending"}
            onClose={() => setDeleting(undefined)}
            actions={
              <>
                <Button
                  disabled={deleteOperation?.delivery === "sending"}
                  onClick={() => setDeleting(undefined)}
                >
                  {deleting.operationId ? "Close" : "Cancel"}
                </Button>
                <Button
                  variant="destructive"
                  disabled={deleteOperation?.delivery === "sending"}
                  onClick={() => {
                    if (deleting.operationId) {
                      reactions.session.outbox?.retry(deleting.operationId);
                      return;
                    }
                    try {
                      const operationId =
                        reactions.session.messages.deleteMessage(
                          deleting.row.id,
                        );
                      setDeleting({ row: deleting.row, operationId });
                    } catch (cause) {
                      setManagementError(
                        cause instanceof Error
                          ? cause.message
                          : "Couldn’t delete.",
                      );
                      setDeleting(undefined);
                    }
                  }}
                >
                  {deleteOperation?.delivery === "sending"
                    ? "Deleting…"
                    : deleteOperation &&
                        ["failed", "unknown"].includes(deleteOperation.delivery)
                      ? "Retry"
                      : "Delete"}
                </Button>
              </>
            }
          >
            {deleteOperation?.error && (
              <p role="alert" className="text-body-sm text-danger">
                {deleteOperation.error}
              </p>
            )}
          </AlertDialog>
        )}
        {reporting && client && (
          <ReportMessageDialog
            report={(type, note) =>
              client.report({ messageId: reporting.id, type, note: note ?? "" })
            }
            close={() => setReporting(undefined)}
          />
        )}
        {pendingNavigation && (
          <AlertDialog
            title="Discard your recording?"
            description="A voice note is being recorded here. Leaving this view discards it."
            onClose={() => setPendingNavigation(undefined)}
            actions={
              <>
                <Button onClick={() => setPendingNavigation(undefined)}>
                  Keep recording
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    const next = pendingNavigation;
                    setPendingNavigation(undefined);
                    if (next.action === "openThread")
                      act("openThread", next.rootId);
                    else act("back");
                  }}
                >
                  Discard and continue
                </Button>
              </>
            }
          />
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
