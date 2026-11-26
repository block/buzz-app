import type { SidebarSectionRow } from "../../features/channel-navigation/sidebar-sections-service";
import type { OpenTarget } from "../../features/navigation/targets";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { InboxItem } from "../../features/relay/inbox";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { ReadEvent } from "../../features/drafts-sent/model";
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

/** A row and where it opens. */
export type AgentWorkRow = SidebarSectionRow &
  Readonly<{
    kind: "solo" | "chat" | "thread";
    channelId: string;
    rootId?: string;
    at: number;
  }>;

/** Agent work, from Activity's own conversations: every Solo chat, and each
 * channel or DM top level and each thread where an agent wrote to you. */
export function agentWorkRows({
  channels,
  items,
  isAgent,
  roots,
}: {
  channels: readonly ChannelSummary[];
  /** Activity's conversations. */
  items: readonly InboxItem[];
  isAgent(pubkey: string): boolean;
  /** Thread roots, which name their rows. */
  roots: readonly ReadEvent[];
}): readonly AgentWorkRow[] {
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  const open = (id: string) => {
    const channel = byId.get(id);
    return channel &&
      !channel.archived &&
      !channel.huddle &&
      !channel.metadataPending
      ? channel
      : undefined;
  };
  const rows = new Map<string, AgentWorkRow>();
  const keep = (row: AgentWorkRow) => {
    const found = rows.get(row.id);
    if (!found || row.at > found.at) rows.set(row.id, row);
  };
  for (const channel of channels)
    if (channel.channelType === "solo" && open(channel.id))
      keep({
        id: `solo:${channel.id}`,
        kind: "solo",
        label: channel.name,
        icon: soloIcon,
        channelId: channel.id,
        at: channel.lastActivityAt ?? 0,
      });
  const text = new Map(roots.map((event) => [event.id, event.content]));
  for (const item of items) {
    const channel = open(item.channelId);
    if (!channel || !isAgent(item.authorId)) continue;
    const at = item.createdAt;
    // A Solo chat is already its own row; it has no threads.
    if (channel.channelType === "solo") {
      const solo = rows.get(`solo:${channel.id}`);
      if (solo && at > solo.at) rows.set(solo.id, { ...solo, at });
      continue;
    }
    if (item.rootId) {
      const root = text.get(item.rootId);
      keep({
        id: `thread:${channel.id}:${item.rootId}`,
        kind: "thread",
        label: (root && plainText(root).trim()) || "Thread",
        icon: threadIcon,
        channelId: channel.id,
        rootId: item.rootId,
        at,
      });
      continue;
    }
    const Icon = channelIcon(channel);
    keep({
      id: `chat:${channel.id}`,
      kind: "chat",
      label: channel.name,
      icon: <Icon size={16} aria-hidden="true" />,
      channelId: channel.id,
      at,
    });
  }
  return [...rows.values()]
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
    .slice(0, AGENT_WORK_LIMIT);
}

/** Where a row opens: a conversation, or a thread beside its channel. */
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
      current = { key, stop: watch(session) };
    };
    connect();
    const stopRelay = relay.subscribe(connect);
    return () => {
      stopRelay();
      current?.stop();
    };
  };
  const watch = (session: RelaySession) => {
    let roots: { key: string; view: View; stop(): void } | undefined;
    let asked = "";
    // An agent is one of yours, or anyone whose profile says so, as
    // Activity's Agents filter counts them.
    const isAgent = (pubkey: string) =>
      session.agentChoices
        .snapshot()
        .identities.some((agent) => agent.pubkey === pubkey) ||
      !!session.profiles.snapshot().get(pubkey)?.isAgent;
    function compute() {
      const items = session.unread.inbox().items;
      const authors = [...new Set(items.map((item) => item.authorId))].sort();
      const ask = authors.join(",");
      if (ask !== asked) {
        asked = ask;
        void session.profiles.ensure(authors, "background").catch(() => {});
      }
      const draft = agentWorkRows({
        channels: session.channels.list().channels,
        items,
        isAgent,
        roots: roots?.view.snapshot().events ?? none,
      });
      // Each thread's first message names its row.
      const ids = [
        ...new Set(draft.flatMap((row) => (row.rootId ? [row.rootId] : []))),
      ].sort();
      const key = ids.join(",");
      if (key !== (roots?.key ?? "")) {
        roots?.stop();
        roots = undefined;
        if (ids.length) {
          const view = session.observe([
            { kinds: [9], ids, limit: ids.length },
          ]);
          // Held before it can report, so a report reuses it, not another.
          const held = { key, view, stop: () => view.dispose() };
          roots = held;
          const stopView = view.subscribe(compute);
          held.stop = () => {
            stopView();
            view.dispose();
          };
          void view.refresh();
        }
      }
      const next = roots
        ? agentWorkRows({
            channels: session.channels.list().channels,
            items,
            isAgent,
            roots: roots.view.snapshot().events,
          })
        : draft;
      if (!sameRows(rows, next)) {
        rows = next;
        notify();
      }
    }
    session.channels.ensureList();
    session.agentChoices.ensure();
    void session.unread.ensure();
    const stops = [
      session.unread.subscribeInbox(compute),
      session.channels.subscribeList(compute),
      session.agentChoices.subscribe(compute),
      session.profiles.subscribe(compute),
    ];
    compute();
    return () => {
      for (const stopOne of stops) stopOne();
      roots?.stop();
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
      row.icon === b[index].icon,
  );
