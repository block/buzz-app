import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Agents } from "../../features/agents/service";
import { CreateChannelDialog } from "../../bundled/channels/CreateChannelDialog";
import { CreateSidebarSection } from "../../bundled/channels/CreateSidebarSection";
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
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuGroup,
  MenuGroupLabel,
  MenuSeparator,
  MenuTrailing,
} from "../../shared/design-system/ui/Menu";
import { KeyboardShortcut } from "../../shared/design-system/ui/KeyboardShortcut";
import styles from "./NewMenu.module.css";
import { PlusIcon } from "../../shared/design-system/icons";

type Props = {
  relay: RelayData;
  navigator: Navigation;
  agents?: Agents | undefined;
  children?: ((trigger: ReactNode) => ReactNode) | undefined;
  onSectionCreated?: (() => void) | undefined;
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
  onSectionCreated,
  children,
}: Props & { session: RelaySession; available: boolean }) {
  useSyncExternalStore(
    session.soloPreferences.subscribe,
    session.soloPreferences.snapshot,
  );
  const preferences = useSidebarPreferences(session.sidebarPreferences);
  const [menuOpen, setMenuOpen] = useState(false);
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [creatingSection, setCreatingSection] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const scope = splitPartition(session.scope);
  const current = () => relay.snapshot().session === session;
  const menu = (
    <MenuRoot open={menuOpen} onOpenChange={setMenuOpen}>
      <span className={styles.createSurface}>
        <MenuTrigger
          render={
            <IconButton
              hint="familiar"
              ref={trigger}
              disabled={!available}
              data-new-menu-trigger=""
              aria-label="New"
              title="New"
              variant="ghost"
              shape="round"
              size="md"
              icon={<PlusIcon className={styles.createIcon} size={18} />}
            />
          }
        />
      </span>
      <MenuPopup
        onKeyDownCapture={(event) => {
          if (
            !menuOpen ||
            event.repeat ||
            event.nativeEvent.isComposing ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            !/^[1-5]$/.test(event.key)
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
              if (current())
                void navigator.open(soloDraftTarget(session.scope));
            }}
          >
            New chat
            <MenuTrailing>
              <span aria-hidden="true">
                <KeyboardShortcut text="1" label="1" />
              </span>
            </MenuTrailing>
          </MenuItem>
          <MenuItem
            aria-keyshortcuts="2"
            disabled={!session.soloPreferences.sectionCreationWritable}
            onClick={() => {
              if (current()) setCreatingProject(true);
            }}
          >
            New workspace
            <MenuTrailing>
              <span aria-hidden="true">
                <KeyboardShortcut text="2" label="2" />
              </span>
            </MenuTrailing>
          </MenuItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel emphasis="quiet">Team</MenuGroupLabel>
          <MenuItem
            aria-keyshortcuts="3"
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
            New DM
            <MenuTrailing>
              <span aria-hidden="true">
                <KeyboardShortcut text="3" label="3" />
              </span>
            </MenuTrailing>
          </MenuItem>
          <MenuItem
            aria-keyshortcuts="4"
            disabled={!session.channelCreation.available}
            onClick={() => {
              if (current()) setCreatingChannel(true);
            }}
          >
            New channel
            <MenuTrailing>
              <span aria-hidden="true">
                <KeyboardShortcut text="4" label="4" />
              </span>
            </MenuTrailing>
          </MenuItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem
          aria-keyshortcuts="5"
          disabled={!preferences.sectionCreationWritable}
          onClick={() => {
            if (current()) setCreatingSection(true);
          }}
        >
          New section
          <MenuTrailing>
            <span aria-hidden="true">
              <KeyboardShortcut text="5" label="5" />
            </span>
          </MenuTrailing>
        </MenuItem>
      </MenuPopup>
    </MenuRoot>
  );
  return (
    <>
      {children ? children(menu) : menu}
      {creatingSection && (
        <CreateSidebarSection
          writable={preferences.sectionCreationWritable}
          refreshing={preferences.status === "loading"}
          retry={preferences.reload}
          finalFocus={trigger}
          close={() => setCreatingSection(false)}
          create={async (section) => {
            if (
              !current() ||
              !session.sidebarPreferences.sectionCreationWritable
            )
              return false;
            await preferences.createSection(section);
            if (current()) {
              setCreatingSection(false);
              onSectionCreated?.();
            }
            return true;
          }}
        />
      )}
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
          create={(section) => session.soloPreferences.createSection(section)}
          close={() => setCreatingProject(false)}
          finalFocus={trigger}
          onCreated={(id) => {
            if (!current()) return;
            resetNewChatProject(session.scope, id);
            void navigator.open(
              soloDraftTarget(session.scope, { project: id }),
            );
          }}
        />
      )}
    </>
  );
}
