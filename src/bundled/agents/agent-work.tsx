import type { SidebarSectionRow } from "../../features/channel-navigation/sidebar-sections-service";
import type { OpenTarget } from "../../features/navigation/targets";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
  SENT_LIMIT,
  UPDATE_KINDS,
  UPDATE_LIMIT,
  accepted,
  sentEntries,
  threadRoot,
  type ReadEvent,
} from "../../features/drafts-sent/model";
import { plainText } from "../../features/notifications/content";
import { channelIcon } from "../../features/channels/channel-icon";
import {
  ChatCircleIcon,
  CornerDownRightIcon,
} from "../../shared/design-system/icons";

const soloIcon = <ChatCircleIcon size={16} aria-hidden="true" />;
const threadIcon = <CornerDownRightIcon size={16} aria-hidden="true" />;

/** The card shows this many conversations, as Activity's card does. */
export const AGENT_WORK_LIMIT = 50;
/** Recent messages read from the viewer's agents. */
const AGENT_MESSAGE_LIMIT = 300;

/** A row and where it opens. */
export type AgentWorkRow = SidebarSectionRow &
  Readonly<{
    kind: "solo" | "chat" | "thread";
    channelId: string;
    rootId?: string;
    at: number;
  }>;

/** Agent work: Solo chats; channels and DMs where the viewer and one of their
 * agents both talk at the top level; and channel threads they both wrote in,
 * the root included. */
export function agentWorkRows({
  channels,
  sent,
  agentEvents,
  agents,
  roots,
  viewer,
}: {
  channels: readonly ChannelSummary[];
  sent: readonly ReadEvent[];
  agentEvents: readonly ReadEvent[];
  agents: ReadonlySet<string>;
  roots: readonly ReadEvent[];
  viewer: string;
}): readonly AgentWorkRow[] {
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  const open = (id: string | undefined) => {
    const channel = id ? byId.get(id) : undefined;
    return channel &&
      !channel.archived &&
      !channel.huddle &&
      !channel.metadataPending
      ? channel
      : undefined;
  };
  const rows: AgentWorkRow[] = [];
  for (const channel of channels)
    if (channel.channelType === "solo" && open(channel.id))
      rows.push({
        id: `solo:${channel.id}`,
        kind: "solo",
        label: channel.name,
        icon: soloIcon,
        channelId: channel.id,
        at: channel.lastActivityAt ?? 0,
      });
  // A Solo chat is already its own row. Threads live in channels; a DM's
  // conversation is its top level.
  const inChannel = (id: string) => {
    const type = open(id)?.channelType;
    return type === "stream" || type === "forum";
  };
  const talks = (id: string) => inChannel(id) || open(id)?.channelType === "dm";
  type Said = { channelId: string; root: string; top: boolean; at: number };
  const latest = (entries: readonly Said[]) => {
    const threads = new Map<string, number>();
    const tops = new Map<string, number>();
    const keep = (found: Map<string, number>, key: string, at: number) =>
      found.set(key, Math.max(found.get(key) ?? 0, at));
    for (const { channelId, root, top, at } of entries) {
      if (inChannel(channelId)) keep(threads, `${channelId}:${root}`, at);
      if (top && talks(channelId)) keep(tops, channelId, at);
    }
    return { threads, tops };
  };
  const mine = latest(
    sentEntries(sent, viewer).flatMap((entry) =>
      entry.createdAt === undefined
        ? []
        : [
            {
              channelId: entry.channelId,
              root: entry.threadRootId ?? entry.id,
              top: !entry.threadRootId,
              at: entry.createdAt,
            },
          ],
    ),
  );
  const channelOf = (event: ReadEvent) =>
    event.tags.find(([name]) => name === "h")?.[1];
  const theirs = latest(
    agentEvents.flatMap((event) => {
      const channelId = channelOf(event);
      return event.kind === 9 &&
        agents.has(event.pubkey) &&
        accepted(event) &&
        channelId
        ? [
            {
              channelId,
              root: threadRoot(event) ?? event.id,
              top: !threadRoot(event),
              at: event.created_at,
            },
          ]
        : [];
    }),
  );
  const text = new Map<string, string>();
  for (const entry of sentEntries(sent, viewer)) text.set(entry.id, entry.text);
  for (const event of [...agentEvents, ...roots])
    if (event.kind === 9 && !text.has(event.id))
      text.set(event.id, event.content);
  for (const [channelId, at] of mine.tops) {
    const agentAt = theirs.tops.get(channelId);
    const channel = byId.get(channelId);
    if (agentAt === undefined || !channel) continue;
    const Icon = channelIcon(channel);
    rows.push({
      id: `chat:${channelId}`,
      kind: "chat",
      label: channel.name,
      icon: <Icon size={16} aria-hidden="true" />,
      channelId,
      at: Math.max(at, agentAt),
    });
  }
  for (const [key, at] of mine.threads) {
    const agentAt = theirs.threads.get(key);
    if (agentAt === undefined) continue;
    const [channelId = "", rootId = ""] = key.split(":");
    const channel = byId.get(channelId);
    const root = text.get(rootId);
    const label = root === undefined ? "" : firstLine(root);
    rows.push({
      id: `thread:${key}`,
      kind: "thread",
      label: label || "Thread",
      icon: threadIcon,
      ...(channel ? { detail: channel.name } : {}),
      channelId,
      rootId,
      at: Math.max(at, agentAt),
    });
  }
  return rows
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
    .slice(0, AGENT_WORK_LIMIT);
}

/** The start of a message as one line; the row cuts it to fit. */
const firstLine = (content: string) => plainText(content).trim();

/** Roots the rows need but neither list holds: someone else began the thread. */
export function missingRoots(rows: readonly AgentWorkRow[]) {
  return rows.flatMap((row) =>
    row.kind === "thread" && row.label === "Thread" && row.rootId
      ? [row.rootId]
      : [],
  );
}

/** Where a row opens: a Solo chat, or a thread beside its channel. */
export function agentWorkTarget(
  row: Pick<AgentWorkRow, "channelId" | "rootId">,
  scope: { viewer: string; communityOrigin: string },
): OpenTarget {
  return {
    version: 1,
    kind: "conversation",
    scope,
    channelId: row.channelId,
    ...(row.rootId ? { messageId: row.rootId, threadRootId: row.rootId } : {}),
  };
}

type View = ReturnType<RelaySession["observe"]>;
const none: readonly never[] = Object.freeze([]);

/** The card's rows, read only while the card is shown. */
export function createAgentWork(relay: RelayData) {
  const listeners = new Set<() => void>();
  let rows: readonly AgentWorkRow[] = none;
  let scope: { viewer: string; communityOrigin: string } | undefined;
  let stop: (() => void) | undefined;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const start = () => {
    let current: { key: string; stop(): void } | undefined;
    const connect = () => {
      const snapshot = relay.snapshot();
      const { viewer, origin, session } = snapshot;
      const key =
        snapshot.status === "ready" && viewer && origin
          ? `${snapshot.scope}:${snapshot.generation}`
          : "";
      if (current?.key === key) return;
      current?.stop();
      current = undefined;
      scope = undefined;
      if (rows.length) {
        rows = none;
        notify();
      }
      if (!key || !viewer || !origin) return;
      scope = { viewer, communityOrigin: origin };
      current = { key, stop: watch(session, viewer) };
    };
    connect();
    const stopRelay = relay.subscribe(connect);
    return () => {
      stopRelay();
      current?.stop();
    };
  };
  const watch = (session: RelaySession, viewer: string) => {
    type Open = { view: View; dispose(): void };
    const views: Partial<
      Record<"sent" | "agents" | "roots", Open | undefined>
    > = {};
    let agentKey = "";
    let rootKey = "";
    const open = (filters: Parameters<RelaySession["observe"]>[0]): Open => {
      const view = session.observe(filters);
      const stopView = view.subscribe(compute);
      void view.refresh();
      return {
        view,
        dispose() {
          stopView();
          view.dispose();
        },
      };
    };
    const agentsOf = () =>
      new Set(
        session.agentChoices.snapshot().identities.map(({ pubkey }) => pubkey),
      );
    function compute() {
      const agents = agentsOf();
      const nextAgentKey = [...agents].sort().join(",");
      if (nextAgentKey !== agentKey) {
        agentKey = nextAgentKey;
        views.agents?.dispose();
        views.agents = agents.size
          ? open([
              { kinds: [9], authors: [...agents], limit: AGENT_MESSAGE_LIMIT },
            ])
          : undefined;
      }
      const next = agentWorkRows({
        channels: session.channels.list().channels,
        sent: views.sent?.view.snapshot().events ?? none,
        agentEvents: views.agents?.view.snapshot().events ?? none,
        roots: views.roots?.view.snapshot().events ?? none,
        agents,
        viewer,
      });
      const missing = missingRoots(next);
      const nextRootKey = missing.sort().join(",");
      if (nextRootKey !== rootKey) {
        rootKey = nextRootKey;
        views.roots?.dispose();
        views.roots = missing.length
          ? open([{ kinds: [9], ids: missing, limit: missing.length }])
          : undefined;
      }
      if (!sameRows(rows, next)) {
        rows = next;
        notify();
      }
    }
    views.sent = open([
      { kinds: [9], authors: [viewer], limit: SENT_LIMIT },
      { kinds: UPDATE_KINDS, authors: [viewer], limit: UPDATE_LIMIT },
    ]);
    session.channels.ensureList();
    session.agentChoices.ensure();
    const stopChannels = session.channels.subscribeList(compute);
    const stopAgents = session.agentChoices.subscribe(compute);
    compute();
    return () => {
      stopChannels();
      stopAgents();
      views.sent?.dispose();
      views.agents?.dispose();
      views.roots?.dispose();
    };
  };
  return {
    snapshot: () => rows,
    subscribe(listener: () => void) {
      listeners.add(listener);
      stop ??= start();
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        stop?.();
        stop = undefined;
      };
    },
    target(row: SidebarSectionRow): OpenTarget {
      const found = rows.find((candidate) => candidate.id === row.id);
      if (!found || !scope)
        throw new Error("This conversation isn't available");
      return agentWorkTarget(found, scope);
    },
  };
}

const sameRows = (a: readonly AgentWorkRow[], b: readonly AgentWorkRow[]) =>
  a.length === b.length &&
  a.every(
    (row, index) =>
      row.id === b[index]?.id &&
      row.label === b[index].label &&
      row.detail === b[index].detail,
  );
