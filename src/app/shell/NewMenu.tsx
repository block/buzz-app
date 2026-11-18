import { createPortal } from "react-dom";
import { useRef, useState, useSyncExternalStore } from "react";
import type { Agents } from "../../features/agents/service";
import type {
  NewMenuItems,
  RegisteredNewMenuItem,
} from "../../features/new-menu/service";
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
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuGroup,
  MenuGroupLabel,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import styles from "./NewMenu.module.css";
import { PlusIcon } from "../../shared/design-system/icons";

type Props = {
  relay: RelayData;
  navigator: Navigation;
  agents?: Agents | undefined;
  items?: NewMenuItems | undefined;
  triggerContainer?: HTMLElement | null;
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
const noItems: readonly RegisteredNewMenuItem[] = [];
const noItemsSnapshot = () => noItems;

function runItem(item: RegisteredNewMenuItem) {
  const fail = (error: unknown) =>
    console.error(`New menu item failed: ${item.key}`, error);
  try {
    void Promise.resolve(item.run()).catch(fail);
  } catch (error) {
    fail(error);
  }
}

function ReadyNewMenu({
  relay,
  navigator,
  agents,
  items,
  session,
  available,
  triggerContainer,
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
  const scope = splitPartition(session.scope);
  const current = () => relay.snapshot().session === session;
  const contributed = useSyncExternalStore(
    items?.subscribe ?? noSubscription,
    items?.snapshot ?? noItemsSnapshot,
  );
  const contributedTo = (group: RegisteredNewMenuItem["group"]) =>
    contributed
      .filter((item) => item.group === group)
      .map((item) => (
        <MenuItem
          key={item.key}
          onClick={() => {
            if (current()) runItem(item);
          }}
        >
          {item.title}
        </MenuItem>
      ));
  const menuTrigger = (
    <MenuTrigger
      render={
        <IconButton
          hint="familiar"
          ref={trigger}
          disabled={!available}
          aria-label="New"
          title="New"
          variant="inset"
          shape="round"
          size="sm"
          icon={<PlusIcon className={styles.createIcon} size={16} />}
        />
      }
    />
  );
  return (
    <>
      <MenuRoot
        open={open}
        onOpenChange={(next) => {
          if (next) setDraftFocus(null);
          onOpenChange?.(next);
        }}
      >
        {triggerContainer === undefined
          ? menuTrigger
          : triggerContainer && createPortal(menuTrigger, triggerContainer)}
        <MenuPopup
          finalFocus={
            draftFocus
              ? () => (draftFocus.isConnected ? draftFocus : false)
              : undefined
          }
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
                New chat
              </MenuItem>
            )}
            <MenuItem
              disabled={!session.soloPreferences.sectionCreationWritable}
              onClick={() => {
                if (current()) setCreatingProject(true);
              }}
            >
              New workspace
            </MenuItem>
            {contributedTo("solo")}
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel emphasis="quiet">Team</MenuGroupLabel>
            <MenuItem
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
            </MenuItem>
            <MenuItem
              disabled={!session.channelCreation.available}
              onClick={() => {
                if (current()) setCreatingChannel(true);
              }}
            >
              New channel
            </MenuItem>
            <MenuItem
              disabled={!preferences.sectionCreationWritable}
              onClick={() => {
                if (current()) setCreatingSection(true);
              }}
            >
              New section
            </MenuItem>
            {contributedTo("team")}
          </MenuGroup>
        </MenuPopup>
      </MenuRoot>
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
      {creatingSection && (
        <CreateSidebarSection
          session={session}
          scope={session.scope}
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
          finalFocus={trigger}
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
