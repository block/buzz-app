import type {
  LocalAgentSource,
  LocalWork,
  LocalWorkState,
} from "../agents/local-activity";
import type { OpenTarget } from "../navigation/targets";

const running = (state: LocalWorkState | undefined) =>
  state === "waiting" || state === "working";
const completed = (state: LocalWorkState) =>
  state === "done" || state === "error";
const keyOf = (work: LocalWork) =>
  JSON.stringify([work.scope, work.agent, work.messageId]);

export function completionTarget(
  work: LocalWork,
  scope: { viewer: string; communityOrigin: string } | undefined,
): OpenTarget | undefined {
  if (!scope) return;
  return {
    version: 1,
    kind: "conversation",
    scope,
    channelId: work.channelId,
    ...(work.thread ? { threadRootId: work.threadRootId } : {}),
    messageId: work.messageId,
  };
}

export function completionBody(
  work: Pick<LocalWork, "state" | "error" | "conversationName">,
) {
  const status =
    work.state === "error"
      ? work.error || "Could not finish this request"
      : "Your reply is ready";
  return work.conversationName
    ? `${work.conversationName} · ${status}`
    : status;
}

export function completionToast(
  agentName: string,
  work: Pick<LocalWork, "state" | "conversationName">,
) {
  const status = work.state === "error" ? "encountered an error" : "finished";
  return work.conversationName
    ? `${agentName} ${status} in ${work.conversationName}`
    : `${agentName} ${status}`;
}

export function shouldShowForegroundCompletion(state: {
  developmentPaused: boolean;
  preferences: {
    enabled: boolean;
    categories: Readonly<Record<string, boolean>>;
  };
}) {
  return (
    !state.developmentPaused &&
    state.preferences.enabled &&
    state.preferences.categories.agent !== false
  );
}

export function isViewingCompletedWork(
  active: OpenTarget,
  completed: OpenTarget,
) {
  return (
    active.kind === "conversation" &&
    completed.kind === "conversation" &&
    active.scope.viewer === completed.scope.viewer &&
    active.scope.communityOrigin === completed.scope.communityOrigin &&
    active.channelId === completed.channelId &&
    active.threadRootId === completed.threadRootId
  );
}

/** One completion observer over the app-owned local work lifecycle. */
export function bindAgentCompletionNotifications(
  activity: LocalAgentSource,
  options: {
    focused(): boolean | Promise<boolean>;
    target(work: LocalWork): OpenTarget | undefined;
    active(): OpenTarget;
    desktop(work: LocalWork, target: OpenTarget): void;
    foreground(work: LocalWork, target: OpenTarget): void;
  },
) {
  let previous = new Map(
    activity.work().map((work) => [keyOf(work), work.state] as const),
  );
  let disposed = false;
  const stop = activity.subscribeWork(() => {
    const next = new Map<string, LocalWorkState>();
    for (const work of activity.work()) {
      const key = keyOf(work);
      const before = previous.get(key);
      next.set(key, work.state);
      if (!running(before) || !completed(work.state) || !work.soloChat)
        continue;
      const target = options.target(work);
      if (!target) continue;
      const present = (focused: boolean) => {
        if (disposed) return;
        if (!focused) options.desktop(work, target);
        else if (!isViewingCompletedWork(options.active(), target))
          options.foreground(work, target);
      };
      const focused = options.focused();
      if (typeof focused === "boolean") present(focused);
      else void focused.then(present, () => present(false));
    }
    previous = next;
  });
  return () => {
    disposed = true;
    stop();
  };
}
