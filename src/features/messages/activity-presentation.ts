import { useMemo, useState } from "react";
import type { ChannelMessage } from "../relay/contracts";
import { continuesMessageGroup } from "./message-grouping";
import { activityRuns } from "./activity-groups";

/** A run of agent coordination updates: readable history only. Live work is
 * never shown here; the conversation's end indicator is its only place. */
export type ActivityPresentation = {
  ids: string[];
  history: ChannelMessage[];
  latest: ChannelMessage;
  participants: string[];
  standalone: boolean;
};
export type ActivityRowPresentation = {
  container: "history" | "bubble" | "standalone";
};

/** Shared projection for timeline and thread; hosts own scrolling and
 * disclosure state. Layout only: it reads messages, never live activity. */
export function activityPresentation(
  rows: readonly ChannelMessage[],
  agents: ReadonlySet<string> | undefined,
  rootId?: string,
) {
  const preceding = new Map(
    rows.map((row, index) => [row.id, rows[index - 1]]),
  );
  const requests = new Map<string, string>();
  if (rootId) requests.set(rootId, rootId);
  const representedAgents = new Map<string, string[]>();
  // Each request's latest public reply row per agent.
  const publicReplies = new Map<string, Map<string, string>>();
  const activityAuthors = new Set(
    rows
      .filter((row) => row.audience === "agents" || row.agentEnvelope)
      .map((row) => row.authorId),
  );
  let request = rootId;
  for (const row of rows) {
    const isAgent =
      activityAuthors.has(row.authorId) || agents?.has(row.authorId);
    if (
      row.audience !== "agents" &&
      !isAgent &&
      !row.membership &&
      agents &&
      !agents.has(row.authorId)
    )
      request = row.id;
    // A thread root is a scope, not necessarily the latest triggering request.
    // Preserve explicit reply links; otherwise follow the preceding request.
    const parentRequest = row.replyParentId
      ? (requests.get(row.replyParentId) ?? row.replyParentId)
      : undefined;
    const rowRequest = isAgent ? (parentRequest ?? request) : request;
    if (rowRequest) requests.set(row.id, rowRequest);
    if (rowRequest && !row.membership && isAgent) {
      const represented = representedAgents.get(rowRequest) ?? [];
      if (!represented.includes(row.authorId)) represented.push(row.authorId);
      representedAgents.set(rowRequest, represented);
      if (row.audience !== "agents") {
        const replies = publicReplies.get(rowRequest) ?? new Map();
        replies.set(row.authorId, row.id);
        publicReplies.set(rowRequest, replies);
      }
    }
  }
  const repliedAgents = new Map<string, string[]>();
  const replyRequests = new Map<string, string>();
  for (const [requestId, replies] of publicReplies) {
    repliedAgents.set(requestId, [...replies.keys()]);
    for (const id of replies.values()) replyRequests.set(id, requestId);
  }
  const groups: ActivityPresentation[] = [];
  const bubbleAnchors = new Set<string>();
  const byRow = new Map<string, ActivityRowPresentation>();
  for (const history of activityRuns(rows, requests)) {
    const first = history[0];
    const latest = history.at(-1);
    if (!first || !latest) continue;
    const participants = [...new Set(history.map((row) => row.authorId))];
    const anchor = preceding.get(first.id);
    const standalone =
      !anchor ||
      !!anchor.membership ||
      anchor.audience === "agents" ||
      anchor.authorId !== first.authorId ||
      anchor.threadRootId !== first.threadRootId ||
      !continuesMessageGroup(anchor, first);
    if (!standalone && anchor) bubbleAnchors.add(anchor.id);
    for (const row of history)
      byRow.set(row.id, {
        container: row.id === first.id && standalone ? "standalone" : "bubble",
      });
    groups.push({
      ids: history.map((row) => row.id),
      history,
      latest,
      participants,
      standalone,
    });
  }
  return {
    groups,
    byRow,
    representedAgents,
    repliedAgents,
    replyRequests,
    bubbleAnchors,
  };
}
export function useActivityPresentation(
  rows: readonly ChannelMessage[],
  agents: ReadonlySet<string> | undefined,
  rootId?: string,
) {
  return useMemo(
    () => activityPresentation(rows, agents, rootId),
    [rows, agents, rootId],
  );
}

/** Each activity projection allocates fresh row values. Reuse the previous ones
 * while they are equal, so memoized rows skip unrelated activity updates. */
export function useStableRowActivity() {
  const [stable] = useState(() => {
    const activities = new Map<string, ActivityRowPresentation>();
    const agents = new Map<string, readonly string[]>();
    return {
      activity(
        id: string,
        next: ActivityRowPresentation | undefined,
        container = next?.container,
      ) {
        if (!next || !container) {
          activities.delete(id);
          return undefined;
        }
        const prior = activities.get(id);
        if (prior?.container === container) return prior;
        const value = { container };
        activities.set(id, value);
        return value;
      },
      agents(id: string, next: readonly string[] | undefined) {
        if (!next) {
          agents.delete(id);
          return undefined;
        }
        const prior = agents.get(id);
        if (
          prior &&
          prior.length === next.length &&
          prior.every((agent, index) => agent === next[index])
        )
          return prior;
        agents.set(id, next);
        return next;
      },
    };
  });
  return stable;
}
