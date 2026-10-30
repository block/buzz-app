import { sectionPreferences } from "../../features/channel-navigation/section-preferences";
import { Button } from "../../shared/design-system/ui/Button";
import { useRef, useState, useSyncExternalStore } from "react";
import type { Agents } from "../../features/agents/service";
import { CreateChannelDialog } from "../../bundled/channels/CreateChannelDialog";
import { revealCreatedChannel } from "../../features/channel-navigation/created-channel";
import { useSidebarPreferences } from "../../bundled/channels/useSidebarPreferences";
import type { Navigation } from "../../features/navigation/controller";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { splitPartition } from "../../features/relay/partition";
import { NewWorkspace } from "../../features/solo/NewWorkspace";
import { resetNewChatProject } from "../../features/solo/SoloDraft";
import { soloDraftTarget } from "../../features/channel-navigation/routes";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuIcon,
  MenuGroup,
  MenuGroupLabel,
  MenuSeparator,
  MenuTrailing,
} from "../../shared/design-system/ui/Menu";
import { KeyboardShortcut } from "../../shared/design-system/ui/KeyboardShortcut";
import styles from "./NewMenu.module.css";
import {
  PlusIcon,
  ChatCircleIcon,
  HashIcon,
  FolderSimpleIcon,
} from "../../shared/design-system/icons";

type Props = {
  relay: RelayData;
  navigator: Navigation;
  agents?: Agents | undefined;
};

export function NewMenu(props: Props) {
  const connection = useRelayConnection(props.relay);
  return (
    <ReadyNewMenu
      {...props}
      key={connection.scope ?? "disconnected"}
      session={connection.session}
      available={connection.status === "ready" || !!connection.cached}
    />
  );
}

function ReadyNewMenu({
  relay,
  navigator,
  agents,
  session,
  available,
}: Props & { session: RelaySession; available: boolean }) {
  useSyncExternalStore(
    sectionPreferences(session).subscribe,
    sectionPreferences(session).snapshot,
  );
  const preferences = useSidebarPreferences(sectionPreferences(session));
  const [menuOpen, setMenuOpen] = useState(false);
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const scope = splitPartition(session.scope);
  const current = () => relay.snapshot().session === session;
  const menu = (
    <MenuRoot open={menuOpen} onOpenChange={setMenuOpen}>
      <MenuTrigger
        render={
          <Button
            ref={trigger}
            disabled={!available}
            data-new-conversation-menu=""
            aria-label="New"
            variant="subtle"
            size="sm"
          >
            <PlusIcon className={styles.createIcon} size={16} />
            New
          </Button>
        }
      />

      <MenuPopup
        style={{
          width: "var(--anchor-width)",
          minWidth: 0,
          maxWidth: "var(--available-width)",
        }}
        onKeyDownCapture={(event) => {
          if (
            !menuOpen ||
            event.repeat ||
            event.nativeEvent.isComposing ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            !/^[1-4]$/.test(event.key)
          )
            return;
          const item = event.currentTarget.querySelector<HTMLElement>(
            `[role="menuitem"][aria-keyshortcuts="${event.key}"]`,
          );
          if (!item) return;
          event.preventDefault();
          event.stopPropagation();
          if (item.getAttribute("aria-disabled") !== "true") item.click();
        }}
      >
        <MenuGroup>
          <MenuGroupLabel emphasis="quiet">Solo</MenuGroupLabel>
          <MenuItem
            aria-keyshortcuts="1"
            onClick={() => {
              if (current()) {
                resetNewChatProject(session.scope);
                void navigator.open(soloDraftTarget(session.scope));
              }
            }}
          >
            <MenuIcon>
              <ChatCircleIcon size={16} />
            </MenuIcon>
            New session
            <MenuTrailing>
              <span aria-hidden="true">
                <KeyboardShortcut text="1" label="1" />
              </span>
            </MenuTrailing>
          </MenuItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel emphasis="quiet">Team</MenuGroupLabel>
          <MenuItem
            aria-keyshortcuts="2"
            disabled={!scope}
            onClick={() => {
              if (scope && current())
                void navigator.open({
                  version: 1,
                  kind: "page",
                  pluginId: "buzz.channels",
                  pageId: "channels",
                  scope,
                  route: { version: 1, params: "new-message" },
                });
            }}
          >
            <MenuIcon>
              <ChatCircleIcon size={16} />
            </MenuIcon>
            New DM
            <MenuTrailing>
              <span aria-hidden="true">
                <KeyboardShortcut text="2" label="2" />
              </span>
            </MenuTrailing>
          </MenuItem>
          <MenuItem
            aria-keyshortcuts="3"
            disabled={!session.channelCreation.available}
            onClick={() => {
              if (current()) setCreatingChannel(true);
            }}
          >
            <MenuIcon>
              <HashIcon size={16} />
            </MenuIcon>
            New channel
            <MenuTrailing>
              <span aria-hidden="true">
                <KeyboardShortcut text="3" label="3" />
              </span>
            </MenuTrailing>
          </MenuItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem
          aria-keyshortcuts="4"
          disabled={!sectionPreferences(session).sectionCreationWritable}
          onClick={() => {
            if (current()) setCreatingProject(true);
          }}
        >
          <MenuIcon>
            <FolderSimpleIcon size={16} />
          </MenuIcon>
          New section
          <MenuTrailing>
            <span aria-hidden="true">
              <KeyboardShortcut text="4" label="4" />
            </span>
          </MenuTrailing>
        </MenuItem>
      </MenuPopup>
    </MenuRoot>
  );
  return (
    <>
      {menu}
      <CreateChannelDialog
        open={creatingChannel}
        onOpenChange={setCreatingChannel}
        session={session}
        agents={agents}
        finalFocus={trigger}
        destinations={preferences.data?.sections ?? []}
        initialGroup=""
        groupsReady={preferences.writable}
        onCreate={async (input) => {
          const channelId = await session.channelCreation.create(input);
          revealCreatedChannel(relay, session, navigator, input, channelId);
        }}
      />
      {creatingProject && (
        <NewWorkspace
          session={session}
          create={(section) =>
            sectionPreferences(session).createSection(section)
          }
          close={() => setCreatingProject(false)}
          finalFocus={trigger}
          onCreated={() => {}}
        />
      )}
    </>
  );
}
