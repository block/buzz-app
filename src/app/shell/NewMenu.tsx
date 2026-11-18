import { createPortal } from "react-dom";
import { useRef, useState } from "react";
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
import { hasSoloDraft } from "../../features/solo/draft-projects";
import {
  resetNewChatProject,
  soloDraftInput,
} from "../../features/solo/SoloDraft";
import {
  soloDraft,
  soloDraftTarget,
  resumeSoloDraftTarget,
} from "../../features/channel-navigation/routes";
import { soloNavigationFor } from "../../features/channel-navigation/solo-navigation";
import { readView, writeView } from "../../shared/view-state";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import { CaretDownIcon, PlusIcon } from "../../shared/design-system/icons";
import styles from "./NewMenu.module.css";

type Props = {
  relay: RelayData;
  navigator: Navigation;
  agents?: Agents | undefined;
  triggerContainer?: HTMLElement | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

const actions = {
  chat: "New chat",
  channel: "New channel",
  dm: "New DM",
} as const;
type Action = keyof typeof actions;

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
  triggerContainer,
  open,
  onOpenChange,
}: Props & { session: RelaySession; available: boolean }) {
  const preferences = useSidebarPreferences(session.sidebarPreferences);
  const scope = splitPartition(session.scope);
  const viewKey = "sidebar-new-action";
  const [action, setAction] = useState<Action>(() => {
    const saved = readView<unknown>(session.scope, viewKey, "chat");
    return saved === "channel" || saved === "dm" ? saved : "chat";
  });
  const [channelGroup, setChannelGroup] = useState<string>();
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const primary = useRef<HTMLButtonElement>(null);
  const caret = useRef<HTMLButtonElement>(null);
  const finalFocus = useRef<HTMLElement>(null);
  const [draftFocus, setDraftFocus] = useState<HTMLElement | null>(null);
  const current = () => relay.snapshot().session === session;
  const workspace = () => {
    const target = navigator.snapshot().entry?.target;
    const group =
      target?.kind === "conversation"
        ? preferences.data?.assignments[target.channelId]
        : target?.kind === "page" && target.pluginId === "buzz.channels"
          ? soloDraft(target.route?.params)?.project
          : undefined;
    return preferences.data?.sections.some(({ id }) => id === group)
      ? group
      : undefined;
  };
  const disabled = (kind: Action) =>
    !available ||
    (kind === "channel" && !session.channelCreation.available) ||
    (kind === "dm" && !scope);
  const run = (kind: Action, fromMenu = false) => {
    if (!current() || disabled(kind)) return;
    if (fromMenu) {
      setAction(kind);
      writeView(session.scope, viewKey, kind);
    }
    finalFocus.current = fromMenu ? caret.current : primary.current;
    const project = workspace();
    if (kind === "channel") {
      setChannelGroup(project ?? "");
      return;
    }
    if (kind === "dm") {
      if (scope)
        void navigator.open({
          version: 1,
          kind: "page",
          pluginId: "buzz.channels",
          pageId: "channels",
          scope,
          route: { version: 1, params: "new-message" },
        });
      return;
    }
    const target = navigator.snapshot().entry?.target;
    const destination = resumeSoloDraftTarget(session.scope, target, project);
    const input = destination === target ? soloDraftInput() : null;
    if (input) {
      if (fromMenu) setDraftFocus(input);
      else input.focus();
      return;
    }
    if (project && !hasSoloDraft(session, session.scope, project))
      resetNewChatProject(session.scope, project);
    void navigator.open(destination);
  };
  const controls = (
    <fieldset className={styles.split} aria-label="Create">
      <Button
        ref={primary}
        size="sm"
        variant="subtle"
        shape="control"
        disabled={disabled(action)}
        onClick={() => run(action)}
      >
        <PlusIcon size={15} />
        {actions[action]}
      </Button>
      <MenuTrigger
        render={
          <IconButton
            ref={caret}
            disabled={!available}
            aria-label="New options"
            title="New options"
            variant="inset"
            size="sm"
            icon={<CaretDownIcon size={14} />}
          />
        }
      />
    </fieldset>
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
          ? controls
          : triggerContainer && createPortal(controls, triggerContainer)}
        <MenuPopup
          finalFocus={
            draftFocus
              ? () => (draftFocus.isConnected ? draftFocus : false)
              : channelGroup !== undefined || creatingWorkspace
                ? false
                : undefined
          }
        >
          {(["chat", "channel", "dm"] as const).map((kind) => (
            <MenuItem
              key={kind}
              disabled={disabled(kind)}
              onClick={() => run(kind, true)}
            >
              {actions[kind]}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem
            disabled={!preferences.sectionCreationWritable}
            onClick={() => {
              if (!current()) return;
              finalFocus.current = caret.current;
              setCreatingWorkspace(true);
            }}
          >
            New workspace
          </MenuItem>
        </MenuPopup>
      </MenuRoot>
      <CreateChannelDialog
        open={channelGroup !== undefined}
        onOpenChange={(next) => {
          if (!next) setChannelGroup(undefined);
        }}
        session={session}
        agents={agents}
        finalFocus={finalFocus}
        destinations={preferences.data?.sections ?? []}
        initialGroup={channelGroup ?? ""}
        groupsReady={preferences.writable}
        onCreate={async (input) => {
          const channelId = await session.channelCreation.create(input);
          revealCreatedChannel(relay, session, navigator, input, channelId);
        }}
      />
      {creatingWorkspace && (
        <NewWorkspace
          session={session}
          create={(section) =>
            session.sidebarPreferences.createSection(section)
          }
          close={() => setCreatingWorkspace(false)}
          finalFocus={finalFocus}
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
