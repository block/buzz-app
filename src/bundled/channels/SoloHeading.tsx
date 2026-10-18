import { useRef, useState, type ReactNode, type RefObject } from "react";
import { canEditLifetime } from "../../features/solo/Lifetime";
import { SoloTitle } from "../../features/solo/SoloPresentation";
import { WorkspaceSettings } from "../../features/solo/WorkspaceSettings";
import type { ChannelLifecycleAction } from "../../features/relay/channel-lifecycle-protocol";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { DotsThreeIcon, GearIcon } from "../../shared/design-system/icons";
import { ChannelMembersButton } from "./ChannelMembersDialog";
import {
  NewWorkspaceDialog,
  SoloChatMenuItems,
  useChatCopy,
} from "./SoloChatMenu";
import { SoloShare } from "./SoloShare";
import { ToastNotice } from "../../shared/design-system/ui/Toast";

/** The header of a conversation shown with the Solo treatment. */
export function SoloHeading({
  session,
  scope,
  channel,
  navigator,
  signal,
  children,
  paneToggle,
  onConvert,
  onLifecycle,
}: {
  session: RelaySession;
  scope: string;
  channel: ChannelSummary;
  navigator?: Navigation | undefined;
  signal?: AbortSignal | undefined;
  /** Panel launchers, owned by the conversation page. */
  children?: ReactNode;
  /** The tab pane toggle, owned by the conversation page; it ends the header. */
  paneToggle?: ReactNode;
  onConvert(trigger: HTMLElement | null): void;
  onLifecycle(action: ChannelLifecycleAction, trigger?: HTMLElement): void;
}) {
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const actionsTrigger = useRef<HTMLButtonElement>(null);
  // Each dialog returns focus to the control that opened it.
  const [settingsOpen, setSettingsOpen] = useState<{
    visit: AbortSignal | undefined;
    trigger: RefObject<HTMLButtonElement | null>;
  }>();
  const [sharing, setSharing] = useState<{ visit: AbortSignal | undefined }>();
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [copy, copyNotice] = useChatCopy();
  const [readError, setReadError] = useState<string>();
  return (
    <>
      <SoloTitle
        channel={channel}
        // Archived chats keep their lifecycle actions, including Unarchive.
        actions={
          <>
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
                  <SoloChatMenuItems
                    session={session}
                    channel={channel}
                    onShare={() => setSharing({ visit: signal })}
                    onConvert={() => onConvert(actionsTrigger.current)}
                    onMove={(projectId) =>
                      void session.soloPreferences
                        .assign(channel.id, projectId)
                        .catch(() => {})
                    }
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
          </>
        }
      >
        <ChannelMembersButton session={session} channelId={channel.id} />
        {children}
        <SoloShare
          key={channel.id}
          navigator={navigator}
          session={session}
          channel={channel}
          signal={signal}
          onConvert={onConvert}
        />
        <IconButton
          ref={settingsTrigger}
          size="toolbar"
          aria-label="Chat settings"
          title="Chat settings"
          icon={<GearIcon size="1rem" aria-hidden="true" />}
          disabled={
            !!channel.readOnly ||
            (!session.canvas.available && !canEditLifetime(session, channel))
          }
          onClick={() =>
            setSettingsOpen({ visit: signal, trigger: settingsTrigger })
          }
        />
      </SoloTitle>
      {sharing && (
        <SoloShare
          navigator={navigator}
          session={session}
          channel={channel}
          signal={sharing.visit}
          onConvert={onConvert}
          finalFocus={() => actionsTrigger.current ?? false}
          initialOpen
          renderTrigger={() => null}
          onClose={() => setSharing(undefined)}
        />
      )}
      {creatingWorkspace && (
        <NewWorkspaceDialog
          name={channel.name}
          finalFocus={actionsTrigger}
          close={() => setCreatingWorkspace(false)}
          create={(name) => {
            const preferences = session.soloPreferences;
            if (!preferences.writable) return false;
            void preferences
              .createAndAssign(channel.id, { id: crypto.randomUUID(), name })
              .catch(() => {});
            setCreatingWorkspace(false);
            return true;
          }}
        />
      )}
      {copyNotice}
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
