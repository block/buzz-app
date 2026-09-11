import { UnreadBadge, UnreadOptions } from "./UnreadBadge";
import { SidebarUnread } from "./SidebarUnread";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  Hash,
  Search,
  MoreHorizontal,
  PlugZap,
  MessageCircle,
  Users,
} from "lucide-react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
  useChannelList,
  useChannelWindow,
  useRelayConnection,
} from "../../features/relay/react";
import type { Panels } from "../../features/panels/service";
import { PanelCard } from "../../features/panels/PanelCard";
import { PanelFrame } from "../../features/panels/PanelFrame";
import { OutboxStatus } from "./OutboxStatus";
import { RelayTimings } from "./RelayTimings";
import { LiveStatus } from "./LiveStatus";
import { MessageComposer } from "../../features/messages/MessageComposer";
import { ChannelTimeline } from "../../features/messages/ChannelTimeline";
import { ThreadPanel } from "../../features/messages/ThreadPanel";
import { readView, writeView } from "../../shared/view-state";
import { useChannelLabels } from "./useChannelLabels";
import { useSidebarPreferences } from "./useSidebarPreferences";
import { sidebarSections } from "./sidebar-sections";
import styles from "./Channels.module.css";

export function ChannelsPage({
  extensions,
  relay,
  panels,
  companion,
}: {
  extensions?: ConversationExtensions | undefined;
  relay: RelayData;
  panels: Panels;
  companion?: ReactNode;
}) {
  const session = useRelayConnection(relay);
  return (
    <section className={styles.root} aria-label="Channels">
      {session.status !== "ready" ? (
        <PanelFrame companion={companion}>
          <div className={styles.connect}>
            <div className={styles.connectIcon}>
              <PlugZap size={30} />
            </div>
            <h1>Your channels, one conversation.</h1>
            <p>
              {session.status === "connecting"
                ? "Connecting to your relay…"
                : (session.error ??
                  "Use Switch community at the top left to choose or add a community. Your profile and settings work without a community.")}
            </p>
            {session.status === "error" && (
              <>
                <button type="button" onClick={relay.retry}>
                  Connect relay
                </button>
                <p className={styles.note}>
                  For development, set <code>BUZZ_DEV_VIEWER</code> to your Buzz
                  public key in <code>.env.local</code>, then restart{" "}
                  <code>just web</code> or <code>just desktop</code>. See
                  README.md for requirements.
                </p>
              </>
            )}
          </div>
        </PanelFrame>
      ) : (
        <ChannelWorkspace
          extensions={extensions}
          key={`${session.scope ?? "disconnected"}:${session.generation}`}
          scope={session.scope ?? "disconnected"}
          queries={session.session}
          panels={panels}
          companion={companion}
        />
      )}
    </section>
  );
}

function ChannelWorkspace({
  extensions,
  queries,
  panels,
  scope,
  companion,
}: {
  extensions?: ConversationExtensions | undefined;
  companion?: ReactNode;
  scope: string;
  queries: RelaySession;
  panels: Panels;
}) {
  const list = useChannelList(queries.channels);
  const preferences = useSidebarPreferences(queries.sidebarPreferences);
  useEffect(() => {
    if (list.status === "ready") void queries.unread.ensure();
  }, [queries, list.status]);
  const available = useSyncExternalStore(
    panels.subscribe,
    panels.snapshot,
    panels.snapshot,
  );
  const [selected, setSelected] = useState<string | undefined>(() =>
    readView(scope, "selected-channel", undefined),
  );
  const select = (id: string) => {
    setSelected(id);
    writeView(scope, "selected-channel", id);
  };
  const [thread, setThread] = useState<{
    channelId: string;
    messageId: string;
  }>();
  const threadTrigger = useRef<HTMLElement | null>(null);
  const [sent, setSent] = useState<{ channelId: string; id: string }>();
  const [search, setSearch] = useState("");
  const channels = useChannelLabels(list.channels, queries.profiles);
  const current =
    channels.find((channel) => channel.id === selected) ?? channels[0];
  const showingThread = thread?.channelId === current?.id ? thread : undefined;
  useEffect(() => {
    if (thread && !showingThread) setThread(undefined);
  }, [thread, showingThread]);
  const openThread = useCallback(
    (messageId: string) => {
      if (!current) return;
      threadTrigger.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setThread({ channelId: current.id, messageId });
      open(undefined);
    },
    [current],
  );
  const closeThread = useCallback(() => {
    setThread(undefined);
    if (threadTrigger.current?.isConnected) threadTrigger.current.focus();
  }, []);
  const [opened, open] = useState<{
    channelId: string;
    key: string;
    revision: string;
    target: string;
  }>();
  const panel =
    opened?.channelId === current?.id
      ? available.find(
          (panel) =>
            panel.key === opened?.key && panel.revision === opened.revision,
        )
      : undefined;
  useEffect(() => {
    if (opened && !panel) open(undefined);
  }, [opened, panel]);
  const close = useCallback(() => open(undefined), []);
  const openLink = useCallback(
    (url: string) => {
      const candidate = panels.resolve(url);
      if (current && candidate) {
        setThread(undefined);
        open({
          channelId: current.id,
          key: candidate.key,
          revision: candidate.revision,
          target: url,
        });
        return true;
      }
      return false;
    },
    [panels, current],
  );
  const visible = useMemo(
    () =>
      channels.filter((channel) =>
        channel.name.toLowerCase().includes(search.toLowerCase()),
      ),
    [channels, search],
  );
  return (
    <div
      className={`${styles.board} ${panel || showingThread || companion ? styles.withPanel : ""}`}
    >
      <aside className={styles.sidebar} aria-label="Channel sidebar">
        <div className={styles.search}>
          <Search size={17} />
          <input
            aria-label="Search channels"
            placeholder="Search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <SidebarUnread>
          {sidebarSections(visible, preferences.data).map((section) => (
            <details key={section.key} className={styles.channelSection} open>
              <summary>
                {section.icon && (
                  <span aria-hidden="true">{section.icon} </span>
                )}
                {section.title}
              </summary>
              {section.rows.map((channel) => {
                const Icon =
                  channel.channelType === "dm"
                    ? (channel.participants?.length ?? 0) > 1
                      ? Users
                      : MessageCircle
                    : Hash;
                return (
                  <button
                    key={channel.id}
                    type="button"
                    title={channel.name}
                    data-channel-id={channel.id}
                    aria-current={
                      current?.id === channel.id ? "page" : undefined
                    }
                    onPointerEnter={() =>
                      queries.channels.prepare?.(channel.id)
                    }
                    onFocus={() => queries.channels.prepare?.(channel.id)}
                    onClick={() => select(channel.id)}
                  >
                    <Icon size={17} />
                    <span>{channel.name}</span>
                    <UnreadBadge session={queries} channelId={channel.id} />
                  </button>
                );
              })}
            </details>
          ))}
          {list.status === "loading" && !list.channels.length && (
            <p className={styles.empty}>Loading your channels…</p>
          )}
          {list.status === "error" && (
            <p role="alert" className={styles.empty}>
              {list.error}
            </p>
          )}
          {list.status === "ready" && !visible.length && (
            <p className={styles.empty}>
              {search ? "No matching channels." : "No channels yet."}
            </p>
          )}
        </SidebarUnread>
        {preferences.status !== "ready" && (
          <div className={styles.preferenceNotice} role="status">
            {preferences.status === "loading"
              ? "Loading saved groups and stars…"
              : preferences.status === "unsupported"
                ? "Saved groups and stars aren’t supported by this host yet."
                : "Couldn’t refresh saved groups and stars. Your conversations are still available."}
            {preferences.status === "error" && (
              <button type="button" onClick={preferences.reload}>
                Retry
              </button>
            )}
          </div>
        )}
      </aside>
      <article className={styles.conversation} aria-label="Conversation">
        <header className={styles.heading}>
          <div className={styles.channelTitle}>
            {current?.channelType === "dm" ? (
              <MessageCircle size={20} />
            ) : (
              <Hash size={20} />
            )}
            <strong>{current?.name ?? "Channels"}</strong>
          </div>
          <details className={styles.diagnostics}>
            <summary
              aria-label="Conversation options"
              title="Conversation options"
            >
              <MoreHorizontal size={19} aria-hidden="true" />
            </summary>
            <div className={styles.diagnosticsMenu}>
              <UnreadOptions session={queries} channelId={current?.id} />
              <details>
                <summary>Diagnostics</summary>
                <LiveStatus
                  live={queries.live}
                  channelId={current?.id}
                  partialRoster={list.coverage === "partial"}
                  diagnostics
                />
                <p>
                  {list.coverage === "partial" ? "Partial roster" : "Roster"} ·{" "}
                  {channels.length} channels
                </p>
                <button
                  type="button"
                  onClick={() => queries.channels.refreshList?.()}
                >
                  Refresh channels
                </button>
                {preferences.error && (
                  <p>Saved groups and stars: {preferences.error}</p>
                )}
                {preferences.status !== "unsupported" && (
                  <button
                    type="button"
                    disabled={preferences.status === "loading"}
                    onClick={preferences.reload}
                  >
                    Refresh groups and stars
                  </button>
                )}
                {current && (
                  <button
                    type="button"
                    onClick={() => queries.channels.refresh?.(current.id)}
                  >
                    Refresh messages
                  </button>
                )}
                {queries.outbox ? (
                  <OutboxStatus
                    outbox={queries.outbox}
                    profiling={queries.profiling}
                  />
                ) : (
                  <RelayTimings profiling={queries.profiling} />
                )}
              </details>
            </div>
          </details>
        </header>
        <LiveStatus
          live={queries.live}
          channelId={current?.id}
          partialRoster={list.coverage === "partial"}
        />
        {current ? (
          <ChannelBody
            extensions={extensions}
            key={current.id}
            queries={queries}
            scope={scope}
            channelId={current.id}
            onOpenLink={openLink}
            onOpenThread={openThread}
            revealMessageId={
              sent?.channelId === current.id ? sent.id : undefined
            }
          />
        ) : (
          <div className={styles.empty}>Select a channel to read it.</div>
        )}
        {current && (
          <MessageComposer
            extensions={extensions}
            key={`composer:${current.id}`}
            session={queries}
            scope={scope}
            channelId={current.id}
            channelName={current.name}
            onSend={(id) => setSent({ channelId: current.id, id })}
          />
        )}
      </article>
      {(panel || showingThread || companion) && (
        <div className={styles.panelStack}>
          {showingThread && (
            <ThreadPanel
              extensions={extensions}
              key={`${showingThread.channelId}:${showingThread.messageId}`}
              session={queries}
              scope={scope}
              channelName={current?.name ?? ""}
              channelId={showingThread.channelId}
              messageId={showingThread.messageId}
              close={closeThread}
              onOpenLink={openLink}
            />
          )}

          {panel && opened && (
            <PanelCard
              key="target"
              panel={panel}
              target={opened.target}
              close={close}
              closeLabel="Close channel panel"
            />
          )}
          {companion && (
            <div key="companion" className={styles.companion}>
              {companion}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChannelBody({
  extensions,
  scope,
  queries,
  channelId,
  onOpenLink,
  revealMessageId,
  onOpenThread,
}: {
  extensions?: ConversationExtensions | undefined;
  scope: string;
  queries: RelaySession;
  channelId: string;
  onOpenLink(url: string): boolean;
  revealMessageId?: string | undefined;
  onOpenThread(messageId: string): void;
}) {
  const window = useChannelWindow(queries.channels, channelId);
  if (window.status === "error" && !window.rows.length)
    return (
      <div className={styles.empty} role="alert">
        <p>{window.error}</p>
        <button
          type="button"
          onClick={() => queries.channels.ensure(channelId)}
        >
          Retry messages
        </button>
      </div>
    );
  if (window.status !== "ready" && !window.rows.length)
    return (
      <div className={styles.empty} role="status">
        Loading messages…
      </div>
    );
  return (
    <ChannelTimeline
      extensions={extensions}
      scope={scope}
      channelId={channelId}
      queries={queries}
      window={window}
      onOpenLink={onOpenLink}
      onOpenThread={onOpenThread}
      revealMessageId={revealMessageId}
    />
  );
}
