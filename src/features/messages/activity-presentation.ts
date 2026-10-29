import { useMemo, useSyncExternalStore } from "react";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { requestWork } from "../agents/request-work";
import { continuesMessageGroup } from "./message-grouping";
import { activityRuns } from "./activity-groups";

type Activity = RelaySession["agentActivity"];
type Snapshot = ReturnType<Activity["snapshot"]>;
type ActivityRun = {
  ids: string[];
  history: ChannelMessage[];
  latest: ChannelMessage;
  participants: string[];
  requestId: string | undefined;
  followingMessage: ChannelMessage | undefined;
};
export type ActivityPresentation = ActivityRun & {
  done: boolean;
  working: boolean;
  standalone: boolean;
};
export type ActivityRowPresentation = {
  requestId: string | undefined;
  active: boolean;
  ownsLive: boolean;
  container: "history" | "bubble" | "standalone";
};
const noSubscribe = () => () => {};
const noActivity = () => undefined;
export function useActivitySnapshot(activity: Activity | undefined) {
  return useSyncExternalStore(
    activity?.subscribe ?? noSubscribe,
    activity?.snapshot ?? noActivity,
  );
}

/** Status belongs to the triggering request, never to all work in its thread. */
function activityStatus(group: ActivityRun, snapshot: Snapshot | undefined) {
  const { latest, participants, followingMessage: response, requestId } = group;
  const closed =
    !!response &&
    response.audience !== "agents" &&
    !response.membership &&
    response.channelId === latest.channelId &&
    response.threadRootId === latest.threadRootId &&
    response.createdAt >= latest.createdAt &&
    participants.includes(response.authorId);
  const work = snapshot
    ? requestWork(snapshot, latest.channelId, [
        ...(requestId ? [requestId] : []),
        ...group.ids,
      ])
    : [];
  const done =
    closed ||
    participants.every((agent) =>
      work.some(
        (entry) =>
          entry.agent === agent &&
          (entry.state === "done" ||
            entry.state === "ended" ||
            entry.state === "superseded"),
      ),
    );
  const working = new Set(
    done
      ? []
      : work.filter((entry) => entry.working).map((entry) => entry.agent),
  );
  return { done, working, completedReply: closed ? response : undefined };
}

/** Shared projection for timeline and thread; hosts own scrolling and disclosure state. */
export function activityPresentation(
  rows: readonly ChannelMessage[],
  snapshot: Snapshot | undefined,
  agents: ReadonlySet<string> | undefined,
  rootId?: string,
) {
  const following = new Map(
    rows.map((row, index) => [row.id, rows[index + 1]]),
  );
  const preceding = new Map(
    rows.map((row, index) => [row.id, rows[index - 1]]),
  );
  const requests = new Map<string, string>();
  if (rootId) requests.set(rootId, rootId);
  const representedAgents = new Map<string, string[]>();
  let request = rootId;
  for (const row of rows) {
    if (
      row.audience !== "agents" &&
      !row.agentEnvelope &&
      !row.membership &&
      agents &&
      !agents.has(row.authorId)
    )
      request = row.id;
    // A thread root is a scope, not necessarily the latest triggering request.
    // Preserve explicit reply links; otherwise follow the preceding request.
    const parentRequest = row.replyParentId
      ? requests.get(row.replyParentId)
      : undefined;
    const rowRequest =
      row.agentEnvelope || agents?.has(row.authorId)
        ? (parentRequest ?? request)
        : request;
    if (rowRequest) requests.set(row.id, rowRequest);
    if (
      rowRequest &&
      !row.membership &&
      (row.agentEnvelope || agents?.has(row.authorId))
    ) {
      const represented = representedAgents.get(rowRequest) ?? [];
      if (!represented.includes(row.authorId)) represented.push(row.authorId);
      representedAgents.set(rowRequest, represented);
    }
  }
  const groups: ActivityPresentation[] = [];
  const bubbleAnchors = new Set<string>();
  const byRow = new Map<string, ActivityRowPresentation>();
  for (const history of activityRuns(rows)) {
    const first = history[0];
    const latest = history.at(-1);
    if (!first || !latest) continue;
    const participants = [...new Set(history.map((row) => row.authorId))];
    const group: ActivityRun = {
      ids: history.map((row) => row.id),
      history,
      latest,
      participants,
      requestId: requests.get(first.id) ?? first.threadRootId,
      followingMessage: following.get(latest.id),
    };
    const { done, working, completedReply } = activityStatus(group, snapshot);
    const before = preceding.get(first.id);
    const anchor =
      completedReply?.authorId === first.authorId ? completedReply : before;
    const standalone =
      !anchor ||
      !!anchor.membership ||
      anchor.audience === "agents" ||
      anchor.authorId !== first.authorId ||
      anchor.threadRootId !== first.threadRootId ||
      (anchor === before && !continuesMessageGroup(anchor, first));
    if (!standalone && !done && before) bubbleAnchors.add(before.id);
    const lastByAgent = new Map(history.map((row) => [row.authorId, row.id]));
    for (const row of history) {
      const last = lastByAgent.get(row.authorId) === row.id;
      byRow.set(row.id, {
        requestId: group.requestId,
        active: last && working.has(row.authorId),
        ownsLive: last && !done && !group.followingMessage,
        container:
          row.id === first.id && standalone
            ? "standalone"
            : !done || standalone
              ? "bubble"
              : "history",
      });
    }
    groups.push({
      ...group,
      done,
      working: working.size > 0,
      standalone,
    });
  }
  return { groups, byRow, representedAgents, bubbleAnchors };
}
export function useActivityPresentation(
  rows: readonly ChannelMessage[],
  activity: Activity | undefined,
  agents: ReadonlySet<string> | undefined,
  rootId?: string,
) {
  const snapshot = useActivitySnapshot(activity);
  return useMemo(
    () => activityPresentation(rows, snapshot, agents, rootId),
    [rows, snapshot, agents, rootId],
  );
}

/** Finished work stays in Activity rather than the conversation flow. */
export function activityDisplayRows<T extends ChannelMessage>(
  rows: readonly T[],
  groups: readonly ActivityPresentation[],
  revealedId?: string,
): readonly T[] {
  const completed = new Set(
    groups.filter((group) => group.done).flatMap((group) => group.ids),
  );
  return completed.size
    ? rows.filter((row) => row.id === revealedId || !completed.has(row.id))
    : rows;
}
