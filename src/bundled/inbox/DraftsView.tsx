import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import { ThreadPanel } from "../../features/messages/ThreadPanel";
import { ChannelPreview } from "./ChannelPreview";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { Navigation } from "../../features/navigation/controller";
import type { NavigationScope } from "../../features/navigation/targets";
import { selectProfiles } from "../../features/relay/profile-selection";
import { useIdentityNames } from "../../features/identity-names/react";
import { mentionDraft } from "../../features/messages/mention-draft";
import {
  clearView,
  draftCoordinates,
  listDraftViews,
  subscribeView,
} from "../../shared/view-state";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import {
  ArrowSquareOutIcon,
  HashIcon,
  XIcon,
} from "../../shared/design-system/icons/index";
import styles from "./Inbox.module.css";
import { dmLabel } from "./dm-label";

export function DraftsView({
  session,
  scope,
  navigator,
  extensions,
}: {
  session: RelaySession;
  scope: NavigationScope;
  navigator: Navigation;
  extensions?: ConversationExtensions | undefined;
}) {
  const [revision, update] = useState(0);
  useEffect(
    () => subscribeView(session.scope, () => update((value) => value + 1)),
    [session],
  );
  const [selected, setSelected] = useState<string>();
  // Keep an emptied selected draft mounted while its composer is being edited.
  // The composer owns draft contents and storage; Inbox only enumerates its scope.
  const saved = listDraftViews(
    session.scope,
    (value) => !!mentionDraft(value).text.trim(),
    selected,
  );
  const entries = saved.entries
    .flatMap(({ key, value }) => {
      const coordinates = draftCoordinates(key);
      return coordinates
        ? [{ key, draft: mentionDraft(value), coordinates }]
        : [];
    })
    .filter(({ key, draft }) => !!draft.text.trim() || key === selected);
  void revision;
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const channels = list.channels;
  const [limit, setLimit] = useState(50);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const deleteConfirm = useRef<HTMLButtonElement>(null);
  const deleteFocus = useRef<"confirm" | "trigger" | undefined>(undefined);
  useLayoutEffect(() => {
    const target = deleteFocus.current;
    deleteFocus.current = undefined;
    if (target === "confirm" && confirmDelete) deleteConfirm.current?.focus();
    else if (target === "trigger" && !confirmDelete)
      deleteTrigger.current?.focus();
  }, [confirmDelete]);
  const [error, setError] = useState<string>();
  const active = entries.find((entry) => entry.key === selected);
  const channelFor = (channelId: string) =>
    channels.find(
      (item) =>
        item.id === channelId &&
        !item.cached &&
        !item.archived &&
        !item.readOnly &&
        item.members?.includes(scope.viewer),
    );
  const visible = entries.slice(0, limit);
  const profileKey = [
    ...new Set(
      [
        ...visible,
        ...(active && !visible.includes(active) ? [active] : []),
      ].flatMap(({ coordinates }) => {
        const channel = channelFor(coordinates.channelId);
        return channel?.channelType === "dm"
          ? (channel.participants?.slice(0, 3) ?? [])
          : [];
      }),
    ),
  ]
    .sort()
    .join(":");
  const profileIds = useMemo(
    () => (profileKey ? profileKey.split(":") : []),
    [profileKey],
  );
  const selection = useMemo(
    () => selectProfiles(session.profiles, profileIds),
    [session, profileIds],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  const name = useIdentityNames(session.names);
  useEffect(() => {
    // An access/cache reset retires old profile work; a ready roster starts
    // a fresh bounded read for the visible DM destinations.
    void list.asOf;
    if (list.status === "ready" && profileIds.length)
      void session.profiles.ensure(profileIds, "background").catch(() => {});
  }, [session, profileIds, list.status, list.asOf]);
  const destination = (channel: ChannelSummary | undefined) => {
    if (!channel) return "Unavailable conversation";
    if (channel.channelType !== "dm") return `#${channel.name}`;
    return dmLabel(channel.participants, profiles, name);
  };
  const activeChannel = active
    ? channelFor(active.coordinates.channelId)
    : undefined;
  const title = active
    ? !activeChannel
      ? "Draft · Unavailable conversation"
      : activeChannel.channelType === "dm"
        ? active.coordinates.threadRootId
          ? `Draft · Reply in DM with ${destination(activeChannel)}`
          : `Draft · DM to ${destination(activeChannel)}`
        : `Draft · ${active.coordinates.threadRootId ? "Reply in" : "Message to"} ${destination(activeChannel)}`
    : "";
  const open = async () => {
    if (!active) return;
    const channel = channelFor(active.coordinates.channelId);
    if (!channel) {
      setError("This conversation is no longer available.");
      return;
    }
    try {
      const result = await navigator.open({
        version: 1,
        kind: "conversation",
        scope,
        channelId: channel.id,
        ...(active.coordinates.threadRootId
          ? {
              messageId: active.coordinates.threadRootId,
              threadRootId: active.coordinates.threadRootId,
            }
          : {}),
      });
      if (result.status === "failed")
        setError("Could not open the conversation. Try again.");
    } catch {
      setError("Could not open the conversation. Try again.");
    }
  };
  const originAction = (
    <IconButton
      size="toolbar"
      aria-label="Open in origin"
      title="Open in origin"
      onClick={() => void open()}
      icon={<ArrowSquareOutIcon size={18} aria-hidden="true" />}
    />
  );
  const remove = () => {
    if (!active || !confirmDelete) return;
    try {
      clearView(session.scope, active.key);
      setSelected(undefined);
      setConfirmDelete(false);
      setError(undefined);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not delete the draft. Try again.",
      );
    }
  };
  return (
    <div
      className={styles.draftWorkspace}
      data-selected={!!active || undefined}
    >
      <div className={styles.draftList}>
        {!entries.length && (
          <p role="status" className={styles.notice}>
            No drafts
          </p>
        )}
        <ul className={styles.list} aria-label="Drafts">
          {visible.map((entry) => {
            const channel = channelFor(entry.coordinates.channelId);
            const label = destination(channel);
            const dm = channel?.channelType === "dm";
            const first = dm ? channel.participants?.[0] : undefined;
            const artwork = first && profiles.get(first)?.picture;
            return (
              <li
                key={entry.key}
                className={styles.row}
                data-selected={selected === entry.key || undefined}
              >
                <NavigationItem
                  aria-label={`Open draft for ${label}`}
                  selected={selected === entry.key}
                  icon={
                    dm && first ? (
                      <Avatar
                        size="default"
                        alt=""
                        fallback={label}
                        src={artwork ? session.media(artwork) : undefined}
                        shape={
                          profiles.get(first)?.isAgent ? "squircle" : "circle"
                        }
                      />
                    ) : (
                      <HashIcon size={20} aria-hidden="true" />
                    )
                  }
                  label={
                    <span className={styles.content}>
                      <strong
                        className={`text-label-sm text-standard ${styles.sender}`}
                      >
                        {label}
                      </strong>
                      <span className={styles.sourceLine}>
                        <span
                          className={`text-caption ${styles.source}`}
                          data-inbox-source=""
                        >
                          <span className={styles.sourceName}>
                            {entry.coordinates.threadRootId
                              ? "Reply"
                              : "Message"}{" "}
                            · {dm ? "DM" : "Channel"}
                          </span>
                        </span>
                      </span>
                      <span
                        className={`text-body text-subtle ${styles.preview}`}
                      >
                        {entry.draft.text}
                      </span>
                    </span>
                  }
                  onClick={() => {
                    setSelected(entry.key);
                    setConfirmDelete(false);
                    setError(undefined);
                  }}
                />
              </li>
            );
          })}
        </ul>
        {saved.limited && (
          <p className={styles.notice} role="status">
            Showing the first 500 saved drafts. Other drafts remain in their
            conversations.
          </p>
        )}
        {entries.length > limit && (
          <div className={styles.notice}>
            <Button onClick={() => setLimit((value) => value + 50)}>
              Show more
            </Button>
          </div>
        )}
      </div>
      {active && (
        <section aria-label="Draft detail" className={styles.draftDetail}>
          <div className={styles.draftHeading}>
            <h3 className="text-label text-primary">{title}</h3>
            {!activeChannel && (
              <IconButton
                size="toolbar"
                aria-label="Close detail"
                onClick={() => setSelected(undefined)}
                icon={<XIcon size={18} aria-hidden="true" />}
              />
            )}
          </div>
          {error && (
            <p role="alert" className="text-body">
              {error}
            </p>
          )}
          <div className={styles.draftEditor}>
            {activeChannel ? (
              active.coordinates.threadRootId ? (
                <ThreadPanel
                  key={active.key}
                  session={session}
                  scope={session.scope}
                  extensions={extensions}
                  channelId={activeChannel.id}
                  channelName={activeChannel.name}
                  messageId={active.coordinates.threadRootId}
                  close={() => setSelected(undefined)}
                  requireReadyRoot
                  onSend={() => {
                    setSelected(undefined);
                    setConfirmDelete(false);
                    setError(undefined);
                  }}
                  sessionConversation={activeChannel.channelType === "session"}
                  headerActions={originAction}
                  onOpenLink={() => false}
                />
              ) : (
                <ChannelPreview
                  key={active.key}
                  session={session}
                  extensions={extensions}
                  channelId={activeChannel.id}
                  channelName={
                    activeChannel.channelType === "dm"
                      ? `DM with ${destination(activeChannel)}`
                      : activeChannel.name
                  }
                  draft
                  actions={
                    <>
                      {originAction}
                      <IconButton
                        size="toolbar"
                        aria-label="Close detail"
                        onClick={() => setSelected(undefined)}
                        icon={<XIcon size={18} aria-hidden="true" />}
                      />
                    </>
                  }
                  onSend={() => {
                    setSelected(undefined);
                    setConfirmDelete(false);
                    setError(undefined);
                  }}
                />
              )
            ) : (
              <p role="status" className="text-body text-subtle">
                This conversation is unavailable. Your draft is unchanged.
              </p>
            )}
          </div>
          <div className={styles.draftActions}>
            {!confirmDelete ? (
              <Button
                size="sm"
                variant="destructive"
                ref={deleteTrigger}
                onClick={() => {
                  deleteFocus.current = "confirm";
                  setConfirmDelete(true);
                }}
              >
                Delete draft…
              </Button>
            ) : (
              <>
                <span className="text-body">
                  Delete this saved draft on this device?
                </span>
                <Button
                  ref={deleteConfirm}
                  size="sm"
                  variant="destructive"
                  onClick={remove}
                >
                  Delete draft
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    deleteFocus.current = "trigger";
                    setConfirmDelete(false);
                  }}
                >
                  Cancel
                </Button>
              </>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
