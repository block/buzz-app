import { SessionShare } from "./SessionShare";
import { ChannelMembersButton } from "../channels/ChannelMembersDialog";
import { pendingSessionDraft } from "../../features/sessions/pending-start";
import { RenameSession } from "../../features/sessions/RenameSession";
import { WorkspaceSettings } from "../../features/sessions/WorkspaceSettings";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuIcon,
} from "../../shared/design-system/ui/Menu";
import {
  DotsThreeIcon,
  GearIcon,
  PencilSimpleIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { ChatCircleIcon } from "../../shared/design-system/icons/index";
import { useCallback, useState, useSyncExternalStore } from "react";
import type { PageNavigation } from "../../features/navigation/service";
import { useMePlacement } from "../../features/sessions/personal";
import { meSelection, meSection, meTarget } from "../me/routes";
import { subscribeView } from "../../shared/view-state";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import type { Navigation } from "../../features/navigation/controller";
import {
  buzzLinkTarget,
  isBuzzLink,
} from "../../features/navigation/buzz-links";
import {
  useChannelList,
  useChannelWindow,
  useRelayConnection,
} from "../../features/relay/react";
import {
  MessageManagement,
  MessageManagementStatus,
} from "../../features/messages/MessageManagement";
import { ChannelTimeline } from "../../features/messages/ChannelTimeline";
import { rejectUnhandledFileDrop } from "../../features/messages/use-file-drop";
import { MessageComposer } from "../../features/messages/MessageComposer";
import { NewSessionComposer } from "../../features/sessions/NewSessionComposer";
import {
  SessionColumn,
  SessionHeading,
} from "../../features/sessions/SessionPresentation";
import styles from "../../features/sessions/Sessions.module.css";

export function SessionsPage({
  relay,
  extensions,
  navigator,
  navigation,
}: {
  relay: RelayData;
  extensions: ConversationExtensions;
  navigator?: Navigation | undefined;
  navigation?: PageNavigation | undefined;
}) {
  const connection = useRelayConnection(relay);
  return connection.status === "ready" ? (
    <LiveSessions
      key={`${connection.scope}:${connection.generation}`}
      session={connection.session}
      scope={connection.scope ?? ""}
      extensions={extensions}
      navigator={navigator}
      navigation={navigation?.forSession(relay, connection)}
    />
  ) : (
    <section className={styles.empty} aria-label="Me">
      <ChatCircleIcon size={28} />
      <h1>Me</h1>
      <p>
        {connection.status === "connecting"
          ? "Connecting to your community…"
          : "Connect to a community to work with your agents."}
      </p>
      {connection.status === "error" && (
        <>
          <p role="alert">{connection.error ?? "The connection failed."}</p>
          <Button type="button" onClick={relay.retry}>
            Retry connection
          </Button>
        </>
      )}
    </section>
  );
}

function LiveSessions({
  session,
  scope,
  extensions,
  navigator,
  navigation,
}: {
  session: RelaySession;
  scope: string;
  extensions: ConversationExtensions;
  navigator?: Navigation | undefined;
  navigation?: PageNavigation | undefined;
}) {
  const list = useChannelList(session.channels);
  const placement = useMePlacement(session);
  const selected = meSelection(navigation?.target);
  const newSection = meSection(navigation?.target);
  const pendingDraft = useSyncExternalStore(
    useCallback((notify) => subscribeView(scope, notify), [scope]),
    () =>
      selected !== "new" ? pendingSessionDraft(scope, selected) : undefined,
  );
  const selectedSession = list.channels.find((item) => item.id === selected);
  const select = (id: string) => {
    void navigator?.open(meTarget(scope, id));
  };
  if (selected === "new" || pendingDraft)
    return (
      <NewSessionComposer
        personal={
          !pendingDraft ||
          pendingDraft === "me" ||
          pendingDraft.startsWith("me:")
        }
        standalone
        focusRequest={1}
        key={pendingDraft ?? newSection ?? "unfiled"}
        resumeDraftKey={pendingDraft}
        sectionId={
          pendingDraft?.includes(":section:")
            ? pendingDraft.split(":section:")[1]
            : newSection
        }
        extensions={extensions}
        session={session}
        scope={scope}
        onStarted={(id) => {
          if (navigation?.signal.aborted) return;
          if (!session.mePlacement.has(id)) {
            const target = meTarget(scope);
            if (target.kind === "page" && target.scope)
              void navigator?.open({
                version: 1,
                kind: "conversation",
                scope: target.scope,
                channelId: id,
              });
          } else select(id);
        }}
      />
    );
  if (selectedSession)
    return (
      <SessionWork
        key={`${selectedSession.id}:${navigation?.entryId ?? ""}`}
        session={session}
        scope={scope}
        channel={selectedSession}
        navigation={navigation}
        extensions={extensions}
        navigator={navigator}
      />
    );
  return (
    <section className={styles.empty}>
      {placement.status !== "ready" ? (
        <div role="status">
          <p>{placement.error ?? "Loading Me placement…"}</p>
          <Button onClick={() => void session.mePlacement.refresh()}>
            Retry Me
          </Button>
        </div>
      ) : list.status === "loading" ? (
        <p role="status">Loading your conversation…</p>
      ) : (
        <>
          <p>
            This conversation isn’t in your Me workspace. Open it in Messages.
          </p>
          {selectedSession && (
            <Button
              onClick={() => {
                const target = meTarget(scope);
                if (target.kind === "page" && target.scope)
                  void navigator?.open({
                    version: 1,
                    kind: "conversation",
                    scope: target.scope,
                    channelId: selected,
                  });
              }}
            >
              Open in Messages
            </Button>
          )}
          <Button
            onClick={() => {
              session.channels.refreshList?.();
            }}
          >
            Retry
          </Button>
        </>
      )}
    </section>
  );
}

function SessionWork({
  session,
  scope,
  channel,
  extensions,
  parentName,
  navigator,
  navigation,
}: {
  session: RelaySession;
  scope: string;
  channel: ChannelSummary;
  extensions: ConversationExtensions;
  parentName?: string | undefined;
  navigation?: PageNavigation | undefined;
  navigator?: Navigation | undefined;
}) {
  const window = useChannelWindow(session.channels, channel.id);
  const [sent, setSent] = useState<string>();
  const [renameOpen, setRenameOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const placement = useMePlacement(session);
  const inMe = placement.ids.includes(channel.id);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState("");
  const move = async () => {
    if (moving || navigation?.signal.aborted) return;
    setMoving(true);
    setMoveError("");
    try {
      await session.mePlacement.set(channel.id, false);
      if (navigation?.signal.aborted) return;
      const target = sessionLinkTarget(
        `buzz://channel/${channel.id}`,
        scope,
        session.viewer,
      );
      if (target) await navigator?.open(target);
    } catch (error) {
      if (!navigation?.signal.aborted)
        setMoveError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!navigation?.signal.aborted) setMoving(false);
    }
  };
  const targetForLink = useCallback(
    (url: string) => sessionLinkTarget(url, scope, session.viewer),
    [scope, session.viewer],
  );
  const canOpenLink = useCallback(
    (url: string) => !!navigator && !!targetForLink(url),
    [navigator, targetForLink],
  );
  const openLink = useCallback(
    (url: string) => {
      const target = targetForLink(url);
      if (!navigator || !target) return false;
      void navigator.open(target);
      return true;
    },
    [navigator, targetForLink],
  );
  const workspace = (
    // biome-ignore lint/a11y/noStaticElementInteractions: pane file-drop fallback; the composer provides a keyboard-accessible picker.
    <div
      className={styles.work}
      data-attachment-drop-zone=""
      onDragOver={rejectUnhandledFileDrop}
      onDrop={rejectUnhandledFileDrop}
    >
      <SessionHeading channel={channel} parentName={parentName}>
        <ChannelMembersButton session={session} channelId={channel.id} />
        <SessionShare
          session={session}
          channel={channel}
          direct
          signal={navigation?.signal}
          onShared={() => {
            if (navigation?.signal.aborted) return;
            const target = sessionLinkTarget(
              `buzz://channel/${channel.id}`,
              scope,
              session.viewer,
            );
            if (target) void navigator?.open(target);
          }}
        />
        <MenuRoot>
          <MenuTrigger
            render={(props) => (
              <IconButton
                {...props}
                size="toolbar"
                aria-label="Session actions"
                title="Session actions"
                icon={<DotsThreeIcon size="1rem" aria-hidden="true" />}
              />
            )}
          />
          <MenuPopup aria-label="Session actions" align="end">
            <MenuItem
              disabled={moving || placement.status !== "ready"}
              onClick={() => void move()}
            >
              {inMe ? "Move to Messages" : "Open in Messages"}
            </MenuItem>
            <MenuItem
              disabled={
                !!channel.readOnly || !session.channelDetails?.available
              }
              onClick={() => setRenameOpen(true)}
            >
              <MenuIcon>
                <PencilSimpleIcon size={16} />
              </MenuIcon>
              Rename
            </MenuItem>
            <MenuItem
              disabled={!!channel.readOnly || !session.canvas.available}
              onClick={() => setSettingsOpen(true)}
            >
              <MenuIcon>
                <GearIcon size={16} />
              </MenuIcon>
              Session settings…
            </MenuItem>
          </MenuPopup>
        </MenuRoot>
      </SessionHeading>
      {renameOpen && (
        <RenameSession
          key={channel.id}
          session={session}
          id={channel.id}
          name={channel.name}
          close={() => setRenameOpen(false)}
        />
      )}
      {settingsOpen && (
        <WorkspaceSettings
          key={channel.id}
          session={session}
          scope={scope}
          target={{ kind: "session", id: channel.id, name: channel.name }}
          close={() => setSettingsOpen(false)}
        />
      )}
      {placement.status !== "ready" && (
        <div role="status">
          <p>{placement.error ?? "Loading Me placement…"}</p>
          <Button onClick={() => void session.mePlacement.refresh()}>
            Retry Me
          </Button>
        </div>
      )}
      {moveError && <p role="alert">{moveError}</p>}
      {!inMe && placement.status === "ready" && (
        <p role="status">This conversation is in Messages.</p>
      )}
      <SessionColumn>
        <MessageManagementStatus />
        <div className={styles.timeline}>
          {window.status === "error" && !window.rows.length ? (
            <div className={styles.empty} role="alert">
              <p>{window.error}</p>
              <Button
                type="button"
                onClick={() => session.channels.ensure(channel.id)}
              >
                Retry messages
              </Button>
            </div>
          ) : window.status !== "ready" && !window.rows.length ? (
            <p className={styles.empty} role="status">
              Loading messages…
            </p>
          ) : (
            <ChannelTimeline
              historyControl="scroll"
              extensions={extensions}
              queries={session}
              viewer={session.viewer}
              scope={scope}
              channelId={channel.id}
              window={window}
              revealMessageId={sent}
              onOpenLink={openLink}
            />
          )}
        </div>
        <MessageComposer
          sessionConversation
          personalConversation={placement.status !== "ready" || inMe}
          onSend={setSent}
          extensions={extensions}
          session={session}
          scope={scope}
          channelId={channel.id}
          channelName={channel.name}
          label="Message your agents"
          disabled={
            !!channel.archived ||
            window.status !== "ready" ||
            placement.status !== "ready"
          }
          onOpenLink={openLink}
          canOpenLink={canOpenLink}
        />
      </SessionColumn>
    </div>
  );
  return (
    <MessageManagement session={session} channelId={channel.id}>
      {workspace}
    </MessageManagement>
  );
}

export function sessionLinkTarget(
  url: string,
  scope: string,
  viewer: string | undefined,
): ReturnType<typeof buzzLinkTarget> {
  if (!viewer || !isBuzzLink(url)) return null;
  return buzzLinkTarget(url, {
    viewer,
    communityOrigin: scope.slice(0, -(viewer.length + 1)),
  });
}
