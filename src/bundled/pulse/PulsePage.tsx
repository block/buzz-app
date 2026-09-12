import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Hash,
  Inbox,
  MessageCircle,
  Search,
  Sparkles,
  RefreshCw,
  ArrowUpRight,
  Layers,
} from "lucide-react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import { PanelFrame } from "../../features/panels/PanelFrame";
import { MessageRow } from "../../features/messages/MessageRow";
import { readView, writeView } from "../../shared/view-state";
import { channelLabel, filterRows, visibleChannels } from "./feed";
import { usePulseFeed } from "./usePulseFeed";
import { PulseConversation } from "./PulseConversation";
import styles from "./Pulse.module.css";

type View = "for-you" | "all" | "search";
type Selection = { channelId: string; thread?: string | undefined };
const views = [
  { id: "search", title: "Search", icon: Search },
  { id: "for-you", title: "For you", icon: Inbox },
  { id: "all", title: "All messages", icon: Layers },
] as const;
export function PulsePage({
  relay,
  extensions,
  companion,
}: {
  relay: RelayData;
  extensions?: ConversationExtensions | undefined;
  companion?: ReactNode;
}) {
  const connection = useRelayConnection(relay);
  return (
    <section className={styles.root} aria-label="Pulse">
      <PanelFrame companion={companion}>
        {connection.status === "ready" ? (
          <PulseWorkspace
            key={`${connection.scope}:${connection.generation}`}
            session={connection.session}
            scope={connection.scope ?? "disconnected"}
            viewer={connection.viewer}
            extensions={extensions}
          />
        ) : (
          <div className={styles.connect}>
            <Sparkles size={28} aria-hidden="true" />
            <h1>A little closer to what matters.</h1>
            <p>
              {connection.status === "connecting"
                ? "Connecting to your community…"
                : "Connect to a community to see your conversations in Pulse."}
            </p>
            {connection.status === "error" && (
              <>
                <p role="alert">{connection.error}</p>
                <button type="button" onClick={relay.retry}>
                  Retry connection
                </button>
              </>
            )}
          </div>
        )}
      </PanelFrame>
    </section>
  );
}
function PulseWorkspace({
  session,
  scope,
  viewer,
  extensions,
}: {
  session: RelaySession;
  scope: string;
  viewer?: string | undefined;
  extensions?: ConversationExtensions | undefined;
}) {
  const list = useChannelList(session.channels);
  const feed = usePulseFeed(session, list.channels, list.status === "ready");
  const channels = visibleChannels(list.channels);
  const [view, setView] = useState<View>(() => {
    const saved = readView<unknown>(scope, "pulse-view", "all");
    return saved === "for-you" || saved === "search" ? saved : "all";
  });
  const [selected, setSelected] = useState<Selection | undefined>(() => {
    const id = readView<unknown>(scope, "pulse-channel", undefined);
    return typeof id === "string" ? { channelId: id } : undefined;
  });
  const [search, setSearch] = useState("");
  const [channelSearch, setChannelSearch] = useState("");
  const trigger = useRef<HTMLElement | null>(null);
  const current = channels.find(
    (channel) => channel.id === selected?.channelId,
  );
  const open = (channelId: string, thread?: string, source?: HTMLElement) => {
    trigger.current =
      source ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    setSelected({ channelId, thread });
    writeView(scope, "pulse-channel", channelId);
  };
  const back = () => {
    setSelected(undefined);
    writeView(scope, "pulse-channel", null);
    requestAnimationFrame(() => {
      if (trigger.current?.isConnected) trigger.current.focus();
    });
  };
  const switchView = (next: View) => {
    setView(next);
    writeView(scope, "pulse-view", next);
    setSelected(undefined);
    writeView(scope, "pulse-channel", null);
  };
  const rows = useMemo(
    () =>
      filterRows(feed.rows, list.channels, feed.profiles, view, search, viewer),
    [feed.rows, list.channels, feed.profiles, view, search, viewer],
  );
  const scroll = useRef<HTMLDivElement>(null);
  // Freeze channel order while reading; content edits and revoked sources stay live.
  const [order, setOrder] = useState<string[]>([]);
  const rowChannels = rows.map((row) => row.channelId).join("\n");
  useEffect(() => {
    if (!scroll.current || scroll.current.scrollTop <= 24)
      setOrder(rowChannels ? rowChannels.split("\n") : []);
  }, [rowChannels]);
  const ranked = new Map(order.map((id, index) => [id, index]));
  const orderedRows = [...rows].sort(
    (a, b) =>
      (ranked.get(a.channelId) ?? 999) - (ranked.get(b.channelId) ?? 999),
  );
  const pendingOrder = order.join("\n") !== rowChannels;
  const acceptLatest = () => {
    setOrder(rows.map((row) => row.channelId));
    scroll.current?.scrollTo({ top: 0 });
  };
  const matchingChannels = channels.filter((channel) =>
    channelLabel(channel, feed.profiles)
      .toLowerCase()
      .includes(channelSearch.toLowerCase()),
  );
  const title = views.find((item) => item.id === view)?.title;
  const loading =
    list.status === "loading" ||
    (list.status === "ready" &&
      channels.length > 0 &&
      !feed.error &&
      feed.status === "loading");
  return (
    <div className={`${styles.canvas} ${current ? styles.reading : ""}`}>
      <aside className={styles.sidebar} aria-label="Pulse navigation">
        <nav aria-label="Pulse views">
          {views.map(({ id, title, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-current={!current && view === id ? "page" : undefined}
              onClick={() => switchView(id)}
            >
              <span className={styles.navIcon}>
                <Icon size={17} aria-hidden="true" />
              </span>
              {title}
            </button>
          ))}
        </nav>
        <div className={styles.sidebarDivider} />
        <input
          className={styles.channelSearch}
          type="search"
          aria-label="Find a Pulse conversation"
          placeholder="Find a conversation"
          value={channelSearch}
          onChange={(event) => setChannelSearch(event.target.value)}
        />
        <nav className={styles.channelList} aria-label="Pulse conversations">
          {matchingChannels.slice(0, 100).map((channel) => {
            const Icon = channel.channelType === "dm" ? MessageCircle : Hash;
            return (
              <button
                type="button"
                key={channel.id}
                title={channelLabel(channel, feed.profiles)}
                aria-current={current?.id === channel.id ? "page" : undefined}
                onPointerEnter={() => session.channels.prepare?.(channel.id)}
                onFocus={() => session.channels.prepare?.(channel.id)}
                onClick={(event) =>
                  open(channel.id, undefined, event.currentTarget)
                }
              >
                <span className={styles.navIcon}>
                  {channel.channelType === "dm" ? (
                    channelLabel(channel, feed.profiles)
                      .slice(0, 2)
                      .toUpperCase()
                  ) : (
                    <Icon size={16} aria-hidden="true" />
                  )}
                </span>
                <span>{channelLabel(channel, feed.profiles)}</span>
              </button>
            );
          })}
        </nav>
        {list.status === "error" && (
          <div role="alert" className={styles.sidebarError}>
            <p>{list.error}</p>
            <button
              type="button"
              onClick={() => session.channels.refreshList?.()}
            >
              Retry conversations
            </button>
          </div>
        )}
        {matchingChannels.length > 100 && (
          <p className={styles.sidebarFoot}>
            Showing 100 of {matchingChannels.length}. Find a conversation above
            to narrow the list.
          </p>
        )}
      </aside>
      <section className={styles.main} aria-label="Pulse content">
        {current && (
          <PulseConversation
            key={`${current.id}:${selected?.thread ?? ""}`}
            session={session}
            viewer={viewer}
            scope={scope}
            channelId={current.id}
            name={channelLabel(current, feed.profiles)}
            initialThread={selected?.thread}
            extensions={extensions}
            back={back}
          />
        )}
        <div className={styles.feedContent} hidden={!!current}>
          <header className={styles.feedHeading}>
            <div>
              <h1>{title}</h1>
            </div>
            <button
              type="button"
              aria-label="Refresh Pulse"
              title="Refresh Pulse"
              disabled={loading}
              onClick={() => {
                session.channels.refreshList?.();
                feed.refresh();
              }}
            >
              <RefreshCw size={17} aria-hidden="true" />
            </button>
          </header>
          <div className={styles.intro} hidden={view === "all"}>
            {view === "for-you"
              ? "Recent mentions and direct conversations"
              : view === "search"
                ? "Search the recent activity loaded here"
                : "Recent conversations across your community"}
          </div>
          {view === "search" && (
            <label className={styles.search}>
              <Search size={18} aria-hidden="true" />
              <input
                autoComplete="off"
                type="search"
                aria-label="Search recent Pulse activity"
                placeholder="Search this feed"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          )}
          <div className={styles.feed} ref={scroll}>
            {pendingOrder && (
              <button
                className={styles.latest}
                type="button"
                onClick={acceptLatest}
              >
                Show latest activity
              </button>
            )}
            {(feed.error || list.status === "error") && (
              <div role="alert" className={styles.notice}>
                <p>
                  Some activity couldn’t be loaded. This feed may be out of
                  date.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    session.channels.refreshList?.();
                    feed.refresh();
                  }}
                >
                  Try again
                </button>
              </div>
            )}
            {loading && !rows.length ? (
              <p role="status" className={styles.empty}>
                Gathering recent conversations…
              </p>
            ) : rows.length ? (
              orderedRows.map((row) => {
                const channel = channels.find(
                  (item) => item.id === row.channelId,
                );
                if (!channel) return null;
                return (
                  <article
                    className={styles.card}
                    key={row.id}
                    aria-label={`Activity in ${channelLabel(channel, feed.profiles)}`}
                  >
                    <MessageRow
                      row={row}
                      presentation="bubbles"
                      viewer={viewer}
                      context={
                        <button
                          className={styles.source}
                          type="button"
                          onClick={(event) =>
                            open(channel.id, undefined, event.currentTarget)
                          }
                        >
                          {channel.channelType === "dm"
                            ? `DM · ${channelLabel(channel, feed.profiles)}`
                            : `#${channelLabel(channel, feed.profiles)}`}
                        </button>
                      }
                      footer={
                        <div className={styles.cardActions}>
                          <button
                            className={styles.reply}
                            type="button"
                            aria-label="Open thread / reply"
                            onClick={(event) =>
                              open(channel.id, row.id, event.currentTarget)
                            }
                          >
                            <MessageCircle size={16} aria-hidden="true" />
                            <span>Reply</span>
                          </button>
                          <button
                            className={styles.reply}
                            type="button"
                            aria-label="Open conversation ↗"
                            onClick={(event) =>
                              open(channel.id, undefined, event.currentTarget)
                            }
                          >
                            <ArrowUpRight size={16} aria-hidden="true" />
                          </button>
                        </div>
                      }
                      profile={feed.profiles.get(row.authorId)}
                      participantProfiles={feed.profiles}
                      media={session.media}
                      extensions={extensions}
                      day={false}
                      retry={
                        session.outbox ? session.messages.retry : undefined
                      }
                      onOpenLink={() => false}
                    />
                  </article>
                );
              })
            ) : (
              <div className={styles.empty}>
                <Inbox size={28} aria-hidden="true" />
                <h2>A little quiet here</h2>
                <p>
                  {search
                    ? "No recent conversations match that search."
                    : view === "for-you"
                      ? "No direct conversations or mentions in this recent window."
                      : "Recent conversations will appear here."}
                </p>
              </div>
            )}
            <footer className={styles.footer}>
              Recent activity, not complete history
              {list.coverage === "partial" ? " · Partial channel list" : ""}.
              <br />
              Replies go to their original thread.
            </footer>
          </div>
        </div>
      </section>
    </div>
  );
}
