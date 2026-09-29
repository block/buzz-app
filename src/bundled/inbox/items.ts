import type { InboxItem } from "../../features/relay/inbox";
import type { InboxFeedSnapshot } from "../../features/relay/inbox-feed";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelayEvent } from "../../features/relay/events";
import { threadReference } from "../../features/relay/thread-reference";
import type { EntityRoute } from "../../features/projects/routes";
import { entityDtag } from "../../features/projects/routes";
import type { RelaySession } from "../../features/relay/session";

type Row = InboxItem & {
  needsAction?: boolean;
  project?: EntityRoute;
  agent?: boolean;
  source?: "feed";
};
const projectKinds = new Set([1618, 1619, 1621, 1630, 1631, 1632, 1633, 1]);
const projectRef = (
  event: RelayEvent,
  events: ReadonlyMap<string, RelayEvent>,
) => {
  if (!projectKinds.has(event.kind)) return;
  const repos = event.tags.filter(
    ([name, value]) => name === "a" && value?.startsWith("30617:"),
  );
  if (repos.length !== 1) return;
  const repo = repos[0]?.[1];
  const match = /^30617:([a-f0-9]{64}):(.+)$/.exec(repo ?? "");
  if (!match?.[1] || !match[2] || !entityDtag(match[2])) return;
  const refs = event.tags.filter(([name]) => name === "e" || name === "E");
  const marked = refs.filter(
    ([name, , , marker]) => name === "E" || marker === "root",
  );
  const ref =
    marked.length === 1
      ? marked[0]?.[1]
      : marked.length === 0 && refs.length === 1
        ? refs[0]?.[1]
        : undefined;
  const id = [1618, 1621].includes(event.kind) ? event.id : ref;
  const root = id ? events.get(id) : undefined;
  const coordinate = { owner: match[1], dtag: match[2] };
  const verifiedRoot =
    root &&
    [1618, 1621].includes(root.kind) &&
    root.tags.filter(([name]) => name === "a").length === 1 &&
    root.tags.some(([name, value]) => name === "a" && value === repo);
  const destination: EntityRoute = verifiedRoot
    ? { ...coordinate, type: root.kind === 1621 ? "issue" : "pr", id: root.id }
    : { ...coordinate, type: "repo" };
  return { destination, key: `${repo}:${id ?? event.id}` };
};

/** Stable conversation identity is independent of the representative event. */
export function mergeInboxItems(
  retained: readonly InboxItem[],
  feed: InboxFeedSnapshot,
  channels: readonly ChannelSummary[],
  session: RelaySession,
): readonly Row[] {
  const byId = new Map<string, Row>(retained.map((item) => [item.id, item]));
  const agents = new Set(
    session.agentChoices.snapshot().identities.map((agent) => agent.pubkey),
  );
  const grouped = new Map<
    string,
    {
      event: RelayEvent;
      mentioned: boolean;
      needsAction: boolean;
      project?: ReturnType<typeof projectRef>;
    }[]
  >();
  const all = new Map(
    [...feed.mentions, ...feed.needsAction].map((event) => [event.id, event]),
  );
  for (const event of all.values()) {
    // Shared unread owns channel eligibility, deletion, edits and verified ancestry.
    // Finite feed reads already reconcile there through the session's verified reader.
    if (
      [9, 40002, 40008].includes(event.kind) ||
      event.pubkey === session.viewer
    )
      continue;
    const channelId = event.tags.find(([name]) => name === "h")?.[1];
    const project = projectRef(event, all);
    const channel = channels.find(
      (item) =>
        item.id === channelId &&
        !item.cached &&
        item.members?.includes(session.viewer ?? ""),
    );
    if (!project && !channel) continue;
    if (channelId && !channel) continue;
    const root = threadReference(event)?.rootId;
    const key = project
      ? `project:${project.key}`
      : `${channelId}:${channel?.channelType === "dm" ? channelId : (root ?? event.id)}`;
    const list = grouped.get(key) ?? [];
    list.push({
      event,
      mentioned: feed.mentions.some((candidate) => candidate.id === event.id),
      needsAction: feed.needsAction.some(
        (candidate) => candidate.id === event.id,
      ),
      project,
    });
    grouped.set(key, list);
  }
  for (const [key, entries] of grouped) {
    entries.sort(
      (a, b) =>
        b.event.created_at - a.event.created_at ||
        a.event.id.localeCompare(b.event.id),
    );
    const head = entries[0];
    if (!head) continue;
    const channelId = head.event.tags.find(([name]) => name === "h")?.[1] ?? "";
    const previous = byId.get(key);
    const root = threadReference(head.event)?.rootId;
    const needsAction = entries.some((entry) => entry.needsAction);
    const mentioned =
      entries.some((entry) => entry.mentioned) || !!previous?.mentioned;
    if (previous) {
      byId.set(key, {
        ...previous,
        mentioned,
        needsAction,
        agent: agents.has(previous.authorId),
        source: "feed",
        ...(head.project ? { project: head.project.destination } : {}),
        ...(head.event.created_at > previous.createdAt
          ? {
              createdAt: head.event.created_at,
              latestMessageId: head.event.id,
            }
          : {}),
      });
      continue;
    }
    // Nonchat feed activity has no shared unread frontier.
    // Unknown read evidence is not treated as unread or auto-acknowledged.
    const thread = !!root;
    const target =
      channelId && root
        ? { kind: "thread" as const, channelId, rootId: root }
        : { kind: "message" as const, channelId, messageId: head.event.id };
    byId.set(key, {
      id: key,
      channelId,
      target,
      messageId: head.event.id,
      latestMessageId: head.event.id,
      ...(root ? { rootId: root } : {}),
      authorId: head.event.pubkey,
      preview: head.event.content,
      createdAt: head.event.created_at,
      mentioned,
      thread,
      needsAction,
      agent: agents.has(head.event.pubkey),
      source: "feed",
      ...(head.project ? { project: head.project.destination } : {}),
      unreadCount: 0,
      manual: false,
      readThrough: [],
    });
  }
  return [...byId.values()].sort(
    (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
  );
}
export type InboxRow = Row;
