import type { SidebarSectionRow } from "../../features/channel-navigation/sidebar-sections-service";
import type { OpenTarget } from "../../features/navigation/targets";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
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
/** The viewer's own recent messages, which name the conversations to check. */
const OWN_LIMIT = 500;
/** Threads and top levels checked for the viewer's agents. */
const THREAD_CANDIDATES = 300;
/** One filter each, within the relay's ten filters a request. */
const TOP_LEVEL_CANDIDATES = 10;

/** Where the viewer recently talked: each thread, by its root (a top-level
 * message of theirs may have become one), and each channel or DM top level. */
export function agentWorkCandidates(
  sent: readonly ReadEvent[],
  viewer: string,
  channels: readonly ChannelSummary[],
) {
  const talks = new Set(
    channels.flatMap((channel) =>
      !channel.archived &&
      (channel.channelType === "stream" ||
        channel.channelType === "forum" ||
        channel.channelType === "dm")
        ? [channel.id]
        : [],
    ),
  );
  const roots = new Set<string>();
  const tops = new Set<string>();
  // Newest first.
  for (const entry of sentEntries(sent, viewer)) {
    if (!talks.has(entry.channelId)) continue;
    if (roots.size < THREAD_CANDIDATES)
      roots.add(entry.threadRootId ?? entry.id);
    if (!entry.threadRootId && tops.size < TOP_LEVEL_CANDIDATES)
      tops.add(entry.channelId);
  }
  return { roots: [...roots], tops: [...tops] };
}

const chunks = <T,>(values: readonly T[], size: number) =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, index * size + size),
  );

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
  // A Solo chat is already its own row. In a channel or DM, its top level is
  // one conversation and each thread is another.
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
      if (talks(channelId)) keep(threads, `${channelId}:${root}`, at);
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
    const root = text.get(rootId);
    const label = root === undefined ? "" : firstLine(root);
    rows.push({
      id: `thread:${key}`,
      kind: "thread",
      label: label || "Thread",
      icon: threadIcon,
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
      Record<"sent" | "threads" | "tops" | "roots", Open | undefined>
    > = {};
    let lookupKey = "";
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
    const events = (name: keyof typeof views) =>
      views[name]?.view.snapshot().events ?? none;
    function compute() {
      const agents = agentsOf();
      const channels = session.channels.list().channels;
      const sent = events("sent");
      // Look up your agents in each conversation you recently talked in, so a
      // busy agent elsewhere never pushes an older conversation out.
      const { roots, tops } = agentWorkCandidates(sent, viewer, channels);
      const authors = [...agents].sort();
      const nextKey = `${authors}|${roots}|${tops}`;
      if (nextKey !== lookupKey) {
        lookupKey = nextKey;
        for (const name of ["threads", "tops", "roots"] as const) {
          views[name]?.dispose();
          views[name] = undefined;
        }
        if (authors.length && roots.length)
          views.threads = open(
            chunks(roots, 100).map((ids) => ({
              kinds: [9],
              authors,
              "#e": ids,
              limit: 500,
            })),
          );
        if (authors.length && tops.length)
          views.tops = open(
            tops.map((id) => ({ kinds: [9], authors, "#h": [id], limit: 20 })),
          );
        // Each thread's first message: its label, and an agent's when one
        // began it.
        if (roots.length)
          views.roots = open(
            chunks(roots, 100).map((ids) => ({
              kinds: [9],
              ids,
              limit: ids.length,
            })),
          );
      }
      const found = [
        ...events("threads"),
        ...events("tops"),
        ...events("roots"),
      ];
      const next = agentWorkRows({
        channels,
        sent,
        agentEvents: found,
        roots: found,
        agents,
        viewer,
      });
      if (!sameRows(rows, next)) {
        rows = next;
        notify();
      }
    }
    views.sent = open([
      { kinds: [9], authors: [viewer], limit: OWN_LIMIT },
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
      for (const view of Object.values(views)) view?.dispose();
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
    (row, index) => row.id === b[index]?.id && row.label === b[index].label,
  );
