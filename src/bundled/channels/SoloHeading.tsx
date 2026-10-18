import { useRef, useState, type ReactNode } from "react";
import { conversionLabel } from "../../features/solo/conversion";
import {
  soloShareAttempt,
  useSoloShareAttempts,
} from "../../features/solo/share-attempt";
import { canConvertToChannel } from "../../features/solo/ConvertToChannel";
import { canEditLifetime } from "../../features/solo/Lifetime";
import { SoloTitle } from "../../features/solo/SoloPresentation";
import { WorkspaceSettings } from "../../features/solo/WorkspaceSettings";
import type { ChannelLifecycleAction } from "../../features/relay/channel-lifecycle-protocol";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuItem,
  MenuIcon,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import {
  DotsThreeIcon,
  GearIcon,
  HashIcon,
  PencilSimpleIcon,
} from "../../shared/design-system/icons";
import { ChannelLifecycleMenu } from "./ChannelLifecycleMenu";
import { ChannelMembersButton } from "./ChannelMembersDialog";
import { SoloShare } from "./SoloShare";

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
  const shareAttempts = useSoloShareAttempts(session);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const actionsTrigger = useRef<HTMLButtonElement>(null);
  const [settingsOpen, setSettingsOpen] = useState<{
    visit: AbortSignal | undefined;
    rename?: boolean;
  }>();
  const convertible = canConvertToChannel(session, channel);
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
                  {canEditLifetime(session, channel) && (
                    <MenuItem
                      onClick={() =>
                        setSettingsOpen({ visit: signal, rename: true })
                      }
                    >
                      <MenuIcon>
                        <PencilSimpleIcon size={14} />
                      </MenuIcon>
                      Rename
                    </MenuItem>
                  )}
                  {convertible && !channel.archived && (
                    <MenuItem
                      disabled={shareAttempts.has(channel.id)}
                      onClick={() => {
                        if (!soloShareAttempt(session, channel.id))
                          onConvert(actionsTrigger.current);
                      }}
                    >
                      <MenuIcon>
                        <HashIcon size={14} />
                      </MenuIcon>
                      {conversionLabel(session, channel.id)}
                    </MenuItem>
                  )}
                  <ChannelLifecycleMenu
                    archiveLabel="Archive"
                    channelId={channel.id}
                    lifecycle={session.channelLifecycle}
                    disabled={false}
                    separator={convertible && !channel.archived}
                    noun="chat"
                    choose={(action) =>
                      onLifecycle(action, actionsTrigger.current ?? undefined)
                    }
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
          onClick={() => setSettingsOpen({ visit: signal })}
        />
      </SoloTitle>
      {settingsOpen && (
        <WorkspaceSettings
          signal={settingsOpen.visit}
          focusName={settingsOpen.rename}
          finalFocus={settingsOpen.rename ? actionsTrigger : settingsTrigger}
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
