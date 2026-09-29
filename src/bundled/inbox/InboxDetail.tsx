import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";
import type { NavigationScope } from "../../features/navigation/targets";
import type { Navigation } from "../../features/navigation/controller";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import type { InboxRow } from "./items";
import { ThreadPanel } from "../../features/messages/ThreadPanel";
import { ChannelPreview } from "./ChannelPreview";
import { useIdentityNames } from "../../features/identity-names/react";
import { selectProfiles } from "../../features/relay/profile-selection";
import { formatPublicKey } from "../../shared/identity/public-key";
import { entityTarget } from "../../features/projects/routes";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  ArrowSquareOutIcon,
  XIcon,
} from "../../shared/design-system/icons/index";
import styles from "./Inbox.module.css";

export function InboxDetail({
  item,
  anchor,
  session,
  scope,
  navigator,
  extensions,
  channelName,
  onBack,
}: {
  item: InboxRow;
  anchor: string;
  session: RelaySession;
  scope: NavigationScope;
  navigator: Navigation;
  extensions?: ConversationExtensions | undefined;
  channelName: string;
  onBack(): void;
}) {
  const [error, setError] = useState<string>();
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const channel = list.channels.find(
    (candidate) => candidate.id === item.channelId,
  );
  const available =
    !!channel &&
    !channel.cached &&
    !channel.archived &&
    !channel.readOnly &&
    !!channel.members?.includes(scope.viewer);
  const participantKey =
    channel?.channelType === "dm"
      ? (channel.participants ?? []).slice(0, 3).join(":")
      : "";
  const participantIds = useMemo(
    () => (participantKey ? participantKey.split(":") : []),
    [participantKey],
  );
  const selection = useMemo(
    () => selectProfiles(session.profiles, participantIds),
    [session, participantIds],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  const name = useIdentityNames(session.names);
  useEffect(() => {
    void list.asOf;
    if (available && participantIds.length)
      void session.profiles
        .ensure(participantIds, "background")
        .catch(() => {});
  }, [session, participantIds, available, list.asOf]);
  const dmName =
    channel?.channelType === "dm"
      ? channel.participants?.length
        ? channel.participants
            .slice(0, 3)
            .map((id) =>
              name(
                id,
                profiles.get(id)?.name ??
                  formatPublicKey(id) ??
                  "Unknown person",
                channel.participants,
              ),
            )
            .join(", ") +
          (channel.participants.length > 3
            ? ` +${channel.participants.length - 3}`
            : "")
        : "Notes to self"
      : "";
  const open = async () => {
    const destination = item.project
      ? entityTarget(item.project, scope)
      : {
          version: 1 as const,
          kind: "conversation" as const,
          scope,
          channelId: item.channelId,
          messageId: anchor,
          ...(item.rootId ? { threadRootId: item.rootId } : {}),
        };
    const result = await navigator.open(destination);
    if (result.status === "failed")
      setError("This conversation could not be opened. Try again.");
  };
  const isProject = !!item.project;
  const openAction = (
    <IconButton
      size="toolbar"
      aria-label={isProject ? "Open in project" : "Open in channel"}
      onClick={() => void open()}
      icon={<ArrowSquareOutIcon size={18} aria-hidden="true" />}
    />
  );
  return (
    <section className={styles.detail} aria-label="Inbox detail">
      <div className={styles.detailHeading}>
        <h2 className="text-label text-primary">
          {isProject
            ? "Project update"
            : channel?.channelType === "dm"
              ? `DM with ${dmName}`
              : `#${channelName}`}
        </h2>
        {(isProject || !available) && (
          <div className={styles.detailActions}>
            {openAction}
            <IconButton
              size="toolbar"
              aria-label="Close detail"
              onClick={onBack}
              icon={<XIcon size={18} aria-hidden="true" />}
            />
          </div>
        )}
      </div>
      <div className={styles.detailBody}>
        {error && (
          <p role="alert" className={styles.notice}>
            {error}
          </p>
        )}
        {isProject ? (
          <div className={styles.notice}>
            <p>{item.preview || "Project activity"}</p>
            <p className="text-body text-subtle">
              Open the project for its current review or task and actions.
            </p>
          </div>
        ) : !available ? (
          <p role="status" className={styles.notice}>
            This conversation is unavailable. Open it in Channels to check
            access.
          </p>
        ) : item.target.kind === "channel" ? (
          <ChannelPreview
            session={session}
            extensions={extensions}
            channelId={item.channelId}
            channelName={
              channel?.channelType === "dm" ? `DM with ${dmName}` : channelName
            }
            anchor={anchor}
            onClose={onBack}
            exactActions={openAction}
            actions={
              <>
                {openAction}
                <IconButton
                  size="toolbar"
                  aria-label="Close detail"
                  onClick={onBack}
                  icon={<XIcon size={18} aria-hidden="true" />}
                />
              </>
            }
          />
        ) : (
          <ThreadPanel
            session={session}
            scope={session.scope}
            extensions={extensions}
            channelId={item.channelId}
            channelName={channelName}
            messageId={anchor}
            sessionConversation={channel.channelType === "session"}
            revealSelected
            close={onBack}
            onOpenLink={() => false}
            headerActions={openAction}
          />
        )}
      </div>
    </section>
  );
}
