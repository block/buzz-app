import { createPortal } from "react-dom";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Agents } from "../../features/agents/service";
import { CreateSidebarSection } from "../../bundled/channels/CreateSidebarSection";
import { CreateChannelDialog } from "../../bundled/channels/CreateChannelDialog";
import { revealCreatedChannel } from "../../features/channel-navigation/created-channel";
import { useSidebarPreferences } from "../../bundled/channels/useSidebarPreferences";
import type { Navigation } from "../../features/navigation/controller";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { splitPartition } from "../../features/relay/partition";
import { NewWorkspace } from "../../features/solo/NewWorkspace";
import {
  resetNewChatProject,
  soloDraftInput,
} from "../../features/solo/SoloDraft";
import {
  soloDraftTarget,
  resumeSoloDraftTarget,
} from "../../features/channel-navigation/routes";
import { soloNavigationFor } from "../../features/channel-navigation/solo-navigation";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuPopup,
  MenuItem,
  MenuGroup,
  MenuGroupLabel,
  MenuSeparator,
  MenuTrailing,
} from "../../shared/design-system/ui/Menu";
import styles from "./NewMenu.module.css";
import { KeyboardShortcut } from "../../shared/design-system/ui/KeyboardShortcut";
import { PlusIcon } from "../../shared/design-system/icons";

type Props = {
  relay: RelayData;
  navigator: Navigation;
  agents?: Agents | undefined;
  triggerContainer?: HTMLElement | null;
  menuTriggerContainer?: HTMLElement | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
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

const noSubscription = () => () => {};

function ReadyNewMenu({
  relay,
  navigator,
  agents,
  session,
  available,
  triggerContainer,
  menuTriggerContainer,
  open,
  onOpenChange,
}: Props & { session: RelaySession; available: boolean }) {
  useSyncExternalStore(
    session.soloPreferences.subscribe,
    session.soloPreferences.snapshot,
  );
  const preferences = useSidebarPreferences(session.sidebarPreferences);
  // Solo navigation publishes on every channel-list change; the menu only
  // needs to know whether a region source composes workspaces.
  const navigation = soloNavigationFor(session);
  const composing = useSyncExternalStore(
    navigation?.subscribe ?? noSubscription,
    () =>
      !!navigation
        ?.snapshot()
        .regions.find((region) => region.source && !region.hidden)?.source
        ?.composeWorkspaces,
  );
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [creatingSection, setCreatingSection] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [draftFocus, setDraftFocus] = useState<HTMLElement | null>(null);
  const headerTrigger = useRef<HTMLButtonElement>(null);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const openMenu = (anchor: HTMLButtonElement) => {
    menuAnchor.current = anchor;
    setMenuOpen(true);
  };
  const scope = splitPartition(session.scope);
  const current = () => relay.snapshot().session === session;
  // Team creation uses its inline composer; the keyboard shortcut keeps the global picker.
  const [menuOpen, setMenuOpen] = useState(false);
  const compose = (global = false) => {
    if (scope && current())
      void navigator.open({
        version: 1,
        kind: "page",
        pluginId: "buzz.channels",
        pageId: "channels",
        scope,
        route: {
          version: 1,
          params: global ? "new-message" : "compose",
        },
      });
  };
  // The shell's Cmd/Ctrl+N asks to open creation: that is the composer now.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new request composes.
  useEffect(() => {
    if (!open) return;
    onOpenChange?.(false);
    if (available) compose(true);
  }, [open]);
  const shortcut = (position: number) => (
    <MenuTrailing>
      <span aria-hidden="true">
        <KeyboardShortcut text={String(position)} label={`Press ${position}`} />
      </span>
    </MenuTrailing>
  );
  const menuTrigger = (
    <IconButton
      hint="familiar"
      ref={trigger}
      disabled={!available || !scope}
      aria-label="New"
      aria-haspopup="menu"
      title="New message (right-click for more)"
      variant="ghost"
      size="sm"
      icon={
        <PlusIcon className={styles.createIcon} size={16} strokeWidth={2} />
      }
      onClick={() => compose()}
      onContextMenu={(event) => {
        event.preventDefault();
        openMenu(event.currentTarget);
      }}
    />
  );
  return (
    <>
      {triggerContainer === undefined
        ? menuTrigger
        : triggerContainer && createPortal(menuTrigger, triggerContainer)}
      {menuTriggerContainer &&
        createPortal(
          <IconButton
            ref={headerTrigger}
            aria-label="Create"
            title="Create"
            aria-haspopup="menu"
            aria-expanded={
              menuOpen && menuAnchor.current === headerTrigger.current
            }
            disabled={!available || !scope}
            variant="ghost"
            size="sm"
            icon={<PlusIcon size={16} strokeWidth={2} />}
            onClick={(event) => openMenu(event.currentTarget)}
          />,
          menuTriggerContainer,
        )}
      <MenuRoot
        open={menuOpen}
        onOpenChange={(next) => {
          if (next) setDraftFocus(null);
          setMenuOpen(next);
        }}
      >
        <MenuPopup
          anchor={menuAnchor}
          finalFocus={
            draftFocus
              ? () => (draftFocus.isConnected ? draftFocus : false)
              : menuAnchor
          }
          aria-label="New"
          size="compact"
          onKeyDown={(event) => {
            if (
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey ||
              event.repeat ||
              event.nativeEvent.isComposing ||
              !/^[1-9]$/.test(event.key)
            )
              return;
            const item =
              event.currentTarget.querySelectorAll<HTMLElement>(
                '[role="menuitem"]',
              )[Number(event.key) - 1];
            if (!item) return;
            event.preventDefault();
            event.stopPropagation();
            if (item.getAttribute("aria-disabled") !== "true") item.click();
          }}
        >
          <MenuGroup>
            <MenuGroupLabel emphasis="quiet">Solo</MenuGroupLabel>
            {!composing && (
              <MenuItem
                onClick={() => {
                  if (!current()) return;
                  const target = navigator.snapshot().entry?.target;
                  const destination = resumeSoloDraftTarget(
                    session.scope,
                    target,
                  );
                  const input =
                    destination === target ? soloDraftInput() : null;
                  if (input) {
                    setDraftFocus(input);
                    return;
                  }
                  void navigator.open(destination);
                }}
              >
                New solo chat
                {shortcut(1)}
              </MenuItem>
            )}
            <MenuItem
              disabled={!session.soloPreferences.sectionCreationWritable}
              onClick={() => {
                if (current()) setCreatingProject(true);
              }}
            >
              New workspace
              {shortcut(composing ? 1 : 2)}
            </MenuItem>
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel emphasis="quiet">Team</MenuGroupLabel>
            <MenuItem disabled={!scope} onClick={() => compose()}>
              New message
              {shortcut(composing ? 2 : 3)}
            </MenuItem>
            <MenuItem
              disabled={!session.channelCreation.available}
              onClick={() => {
                if (current()) setCreatingChannel(true);
              }}
            >
              New channel
              {shortcut(composing ? 3 : 4)}
            </MenuItem>
            <MenuItem
              disabled={!preferences.sectionCreationWritable}
              onClick={() => {
                if (current()) setCreatingSection(true);
              }}
            >
              New section
              {shortcut(composing ? 4 : 5)}
            </MenuItem>
          </MenuGroup>
        </MenuPopup>
      </MenuRoot>
      <CreateChannelDialog
        open={creatingChannel}
        onOpenChange={setCreatingChannel}
        session={session}
        agents={agents}
        finalFocus={menuAnchor}
        destinations={preferences.data?.sections ?? []}
        initialGroup=""
        groupsReady={preferences.writable}
        onCreate={async (input) => {
          const channelId = await session.channelCreation.create(input);
          revealCreatedChannel(relay, session, navigator, input, channelId);
        }}
      />
      {creatingSection && (
        <CreateSidebarSection
          writable={preferences.sectionCreationWritable}
          refreshing={preferences.status === "loading"}
          retry={preferences.reload}
          finalFocus={menuAnchor}
          close={() => setCreatingSection(false)}
          create={async (section) => {
            if (
              !current() ||
              !session.sidebarPreferences.sectionCreationWritable
            )
              return false;
            await preferences.createSection(section);
            if (current()) setCreatingSection(false);
            return true;
          }}
        />
      )}
      {creatingProject && (
        <NewWorkspace
          session={session}
          create={(section) => session.soloPreferences.createSection(section)}
          close={() => setCreatingProject(false)}
          finalFocus={menuAnchor}
          onCreated={async (id) => {
            if (!current()) return;
            if (await soloNavigationFor(session)?.openCreatedWorkspace(id))
              return;
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
