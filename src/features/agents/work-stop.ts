import type { RelaySession } from "../relay/session";
import type { Agents } from "./service";
import type { RequestWork } from "./request-work";
import type { LocalWork } from "./local-activity";
import { localWorkRoot } from "./local-activity";
import { activityTranscript } from "./activity-transcript";
import { followUpQueue } from "../messages/follow-up-queue";

export type WorkStopAgents = Pick<Agents, "interruptible" | "interrupt">;
export type WorkStop = {
  key: string;
  lifecycle: boolean;
  interrupt: () => Promise<boolean> | Promise<void>;
  /** Top-level work only: pause the chat's queue at once. The promise
   * reports saving the pause, separately from the Stop. */
  pauseQueue?: () => Promise<void>;
};
type Scope = {
  channelId: string;
  messageId: string;
  threadRootId?: string | undefined;
  /** The request is in the conversation, not a thread: its Stop pauses the
   * chat's queued follow-ups. A thread's Stop leaves them alone. */
  topLevel?: boolean;
};
/** Pauses a chat's queued follow-ups for a top-level Stop. */
export const queuePause =
  (session: RelaySession | undefined) => (channelId: string) =>
    session ? followUpQueue(session).pause(channelId) : Promise.resolve();
type Activity = RelaySession["agentActivity"];

/**
 * Whether a request is in the conversation rather than a thread, from the
 * request's own work: local work's thread flag, or the root a hosted turn
 * recorded for it. Undefined when no work names the request.
 */
export function requestTopLevel(
  snapshot: ReturnType<Activity["snapshot"]>,
  agent: string,
  channelId: string,
  requestId: string,
): boolean | undefined {
  const local = (snapshot.local ?? []).find(
    (work) =>
      work.agent === agent &&
      work.channelId === channelId &&
      work.messageId === requestId,
  );
  if (local) return !local.thread;
  for (const turn of snapshot.turns) {
    if (turn.agent !== agent || turn.channelId !== channelId) continue;
    const request = turn.requests?.find((row) => row.messageId === requestId);
    if (request) return request.threadRootId === requestId;
  }
  return undefined;
}

/** Capability and exact scope are shared by request and conversation popovers. */
export function workStop(
  work: Pick<
    RequestWork,
    "agent" | "lifecycle" | "stoppable" | "state" | "working"
  >,
  scope: Scope,
  activity: Activity | undefined,
  agents: WorkStopAgents | undefined,
  pause?: (channelId: string) => Promise<void>,
): WorkStop | undefined {
  const key = JSON.stringify([work.agent, scope.channelId, scope.messageId]);
  const pauseQueue =
    pause && scope.topLevel ? { pauseQueue: () => pause(scope.channelId) } : {};
  if (work.lifecycle) {
    if (
      !activity ||
      !work.stoppable ||
      (work.state !== "working" && work.state !== "waiting")
    )
      return;
    return {
      key,
      lifecycle: true,
      interrupt: () =>
        activity.interrupt(work.agent, scope.channelId, scope.messageId),
      ...pauseQueue,
    };
  }
  const root = scope.threadRootId ?? scope.messageId;
  if (!root || !work.working || !agents?.interruptible(work.agent)) return;
  return {
    key,
    lifecycle: false,
    interrupt: () =>
      agents.interrupt(work.agent, {
        channelId: scope.channelId,
        threadRootId: root,
      }),
    ...pauseQueue,
  };
}

export function conversationWorkStops(
  snapshot: ReturnType<Activity["snapshot"]> | undefined,
  agent: string,
  channelId: string,
  threadRootId: string | undefined,
  activity: Activity | undefined,
  agents: WorkStopAgents | undefined,
  pause?: (channelId: string) => Promise<void>,
): {
  control: WorkStop;
  work?: LocalWork;
  threadRootId?: string | undefined;
}[] {
  if (!snapshot) return [];
  const local = (snapshot.local ?? []).filter(
    (work) =>
      work.agent === agent &&
      work.channelId === channelId &&
      (!threadRootId || work.threadRootId === threadRootId),
  );
  const result = local.flatMap((work) => {
    const control = workStop(
      { ...work, lifecycle: true, working: work.state === "working" },
      { ...work, topLevel: !work.thread },
      activity,
      agents,
      pause,
    );
    return control
      ? [{ control, work, threadRootId: localWorkRoot(work) }]
      : [];
  });
  // Local lifecycle evidence owns this agent's state, including settled work.
  if (local.length || snapshot.status !== "listening") return result;
  const turns = activityTranscript(snapshot.records, {
    agent,
    channelId,
  }).turns;
  // Each root's active turns decide its scope from their own request: a turn
  // its root triggered answers a top-level request; a turn triggered only by
  // replies under that root is thread work. Finished turns never count.
  const roots = new Map<string, boolean>();
  for (const turn of turns) {
    if (
      turn.endedAt ||
      typeof turn.threadRootId !== "string" ||
      (threadRootId && turn.threadRootId !== threadRootId) ||
      !snapshot.turns.some(
        (live) =>
          live.agent === agent &&
          live.channelId === channelId &&
          live.turnId === turn.turnId &&
          live.state === "working",
      )
    )
      continue;
    roots.set(
      turn.threadRootId,
      !!roots.get(turn.threadRootId) ||
        turn.triggeringEventIds.includes(turn.threadRootId),
    );
  }
  return [...roots].flatMap(([root, topLevel]) => {
    const control = workStop(
      { agent, lifecycle: false, working: true, state: "working" },
      {
        channelId,
        messageId: root,
        threadRootId: root,
        topLevel,
      },
      activity,
      agents,
      pause,
    );
    return control ? [{ control, threadRootId: root }] : [];
  });
}
