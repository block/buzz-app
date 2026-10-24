import {
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { SoloTitle } from "../../features/solo/SoloPresentation";
import { WorkspaceSettings } from "../../features/solo/WorkspaceSettings";
import type { ChannelLifecycleAction } from "../../features/relay/channel-lifecycle-protocol";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuIcon,
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import {
  ArrowSquareOutIcon,
  DotsThreeIcon,
} from "../../shared/design-system/icons";
import {
  ChannelMembersButton,
  ChannelMembersDialog,
} from "./ChannelMembersDialog";
import {
  NewWorkspaceDialog,
  SoloChatMenuItems,
  useChatCopy,
} from "./SoloChatMenu";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { useSoloOwner } from "./ChatSharedMark";

type SoloToolbarProps = {
  session: RelaySession;
  scope: string;
  channel: ChannelSummary;
  navigator?: Navigation | undefined;
  signal?: AbortSignal | undefined;
  /** Panel launchers, owned by the conversation page. */
  children?: ReactNode;
  /** The tab pane toggle, owned by the conversation page; it ends the header. */
  paneToggle?: ReactNode;
  /** Shows the chat in the main view, from a host that shows it elsewhere. */
  onOpen?: (() => void) | undefined;
  /** Absent where no host can finish a conversion. */
  onConvert?: ((trigger: HTMLElement | null) => void) | undefined;
  onLifecycle(action: ChannelLifecycleAction, trigger?: HTMLElement): void;
};

/** The header of a conversation shown with the Solo treatment. */
export function SoloHeading(props: SoloToolbarProps) {
  return (
    <SoloTitle channel={props.channel} actions={<SoloToolbar {...props} />} />
  );
}

/** A Solo chat's header actions, wherever the chat is shown. */
export function SoloToolbar({
  session,
  scope,
  channel,
  navigator,
  signal,
  children,
  paneToggle,
  onOpen,
  onConvert,
  onLifecycle,
}: SoloToolbarProps) {
  const actionsTrigger = useRef<HTMLButtonElement>(null);
  // Each dialog returns focus to the control that opened it.
  const [settingsOpen, setSettingsOpen] = useState<{
    visit: AbortSignal | undefined;
    trigger: RefObject<HTMLButtonElement | null>;
  }>();
  const [sharing, setSharing] = useState<{ visit: AbortSignal | undefined }>();
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [copy, copyNotice] = useChatCopy();
  const owner = useSoloOwner(session, channel);
  const [readError, setReadError] = useState<string>();
  // The sidebar may be hidden, so a move started here reports its own failure.
  const preferences = session.soloPreferences;
  const placement = useSyncExternalStore(
    preferences.subscribe,
    preferences.snapshot,
    preferences.snapshot,
  );
  const [moving, setMoving] = useState(false);
  const failedMove = moving
    ? placement.moves?.find(
        (move) => move.channelId === channel.id && move.error,
      )
    : undefined;
  return (
    <>
      {channel.archived ? (
        <span>Archived</span>
      ) : (
        <>
          <ChannelMembersButton
            session={session}
            channelId={channel.id}
            label="Share"
            owner={owner}
            navigator={navigator}
            signal={signal}
          />
          {children}
        </>
      )}
      {/* Archived chats keep their lifecycle actions, including Unarchive. */}
      {!channel.readOnly && !channel.cached && (
        <MenuRoot>
          <MenuTrigger
            render={
              <IconButton
                ref={actionsTrigger}
                size="toolbar"
                aria-label="Chat actions"
                title="Chat actions"
                icon={<DotsThreeIcon size="1rem" aria-hidden="true" />}
              />
            }
          />
          <MenuPopup aria-label="Chat actions" align="end">
            {onOpen && (
              <>
                <MenuItem onClick={onOpen}>
                  <MenuIcon>
                    <ArrowSquareOutIcon size={14} />
                  </MenuIcon>
                  Open in main view
                </MenuItem>
                <MenuSeparator />
              </>
            )}
            <SoloChatMenuItems
              session={session}
              channel={channel}
              onShare={() => setSharing({ visit: signal })}
              onConvert={onConvert && (() => onConvert(actionsTrigger.current))}
              onMove={(projectId) => {
                setMoving(true);
                void preferences.assign(channel.id, projectId).catch(() => {});
              }}
              onNewWorkspace={() => setCreatingWorkspace(true)}
              onCopy={copy}
              onSettings={() =>
                setSettingsOpen({
                  visit: signal,
                  trigger: actionsTrigger,
                })
              }
              onLifecycle={(action) =>
                onLifecycle(action, actionsTrigger.current ?? undefined)
              }
              onReadResult={setReadError}
            />
          </MenuPopup>
        </MenuRoot>
      )}
      {!channel.archived && paneToggle}
      {sharing && (
        <ChannelMembersDialog
          key={channel.id}
          session={session}
          channelId={channel.id}
          navigator={navigator}
          signal={sharing.visit}
          trigger={actionsTrigger}
          close={() => setSharing(undefined)}
        />
      )}
      {creatingWorkspace && (
        <NewWorkspaceDialog
          name={channel.name}
          finalFocus={actionsTrigger}
          close={() => setCreatingWorkspace(false)}
          create={(name) => {
            if (!preferences.writable) return false;
            setMoving(true);
            void preferences
              .createAndAssign(channel.id, { id: crypto.randomUUID(), name })
              .catch(() => {});
            setCreatingWorkspace(false);
            return true;
          }}
        />
      )}
      {copyNotice}
      {failedMove?.error && (
        <ToastNotice
          key={`${failedMove.id}:${failedMove.error}`}
          title="Chat wasn’t moved"
          description={failedMove.error}
          onDismiss={() => {
            preferences.dismissMoveError(channel.id);
            setMoving(false);
          }}
        >
          <Button
            size="sm"
            disabled={!preferences.writable}
            onClick={() =>
              void preferences.retryMove(channel.id).catch(() => {})
            }
          >
            Retry move
          </Button>
        </ToastNotice>
      )}
      {readError && (
        <ToastNotice
          title="Read state couldn’t be saved"
          description={readError}
          onDismiss={() => setReadError(undefined)}
        />
      )}
      {settingsOpen && (
        <WorkspaceSettings
          signal={settingsOpen.visit}
          finalFocus={settingsOpen.trigger}
          key={channel.id}
          session={session}
          scope={scope}
          target={{ kind: "chat", id: channel.id, name: channel.name }}
          close={() => setSettingsOpen(undefined)}
        />
      )}
    </>
  );
}
