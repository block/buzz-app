import type {
  LocalAgentSource,
  LocalWork,
  LocalWorkState,
} from "../agents/local-activity";
import type { OpenTarget } from "../navigation/targets";
import { localWorkRoot } from "../agents/local-activity";

const running = (state: LocalWorkState | undefined) =>
  state === "waiting" || state === "working";
const completed = (state: LocalWorkState) =>
  state === "done" || state === "error";
const keyOf = (work: LocalWork) =>
  JSON.stringify([work.scope, work.agent, work.messageId]);

export const completionSourceKey = (
  work: Pick<LocalWork, "agent" | "messageId" | "state" | "startedAt">,
) => `${work.agent}:${work.messageId}:${work.startedAt}:${work.state}`;

export function completionTarget(
  work: LocalWork,
  scope: { viewer: string; communityOrigin: string } | undefined,
): OpenTarget | undefined {
  if (!scope) return;
  const messageId = work.syntheticMessage
    ? localWorkRoot(work)
    : work.messageId;
  return {
    version: 1,
    kind: "conversation",
    scope,
    channelId: work.channelId,
    ...(work.thread ? { threadRootId: work.threadRootId } : {}),
    ...(messageId ? { messageId } : {}),
  };
}

export function completionTitle(
  agentName: string,
  work: Pick<LocalWork, "state">,
) {
  return work.state === "error"
    ? `${agentName} encountered an error`
    : `${agentName} is done`;
}

export function completionBody(
  work: Pick<LocalWork, "state" | "error" | "conversationName">,
) {
  const destination = work.conversationName
    ? `View in ${work.conversationName}`
    : "View conversation";
  return work.state === "error" && work.error
    ? `${destination} · ${work.error}`
    : destination;
}

export function completionToast(
  agentName: string,
  work: Pick<LocalWork, "state" | "conversationName">,
) {
  const title = completionTitle(agentName, work);
  return work.conversationName ? `${title} in ${work.conversationName}` : title;
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

type Seen = Readonly<{
  state: LocalWorkState;
  solo: boolean;
  startedAt: number;
  /** Publications this run inherited from an earlier attempt. */
  inherited: ReadonlySet<string>;
  /** A quiet `done` whose message was still being published. */
  awaiting?: true;
}>;

/** One completion observer over the app-owned local work lifecycle. A run that
 * ends in error always alerts; one that ends done alerts only once it has
 * published a message here, so a wake that ended quietly makes no sound. */
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
  const seen = (work: LocalWork, before?: Seen): Seen => ({
    state: work.state,
    solo: !!work.soloChat,
    startedAt: work.startedAt,
    inherited:
      before?.startedAt === work.startedAt
        ? before.inherited
        : new Set(work.publishedMessageIds),
  });
  const published = (work: LocalWork, run: Seen) =>
    !!work.publishedMessageIds?.some((id) => !run.inherited.has(id));
  let previous = new Map(
    activity.work().map((work) => [keyOf(work), seen(work)] as const),
  );
  let disposed = false;
  const stop = activity.subscribeWork(() => {
    const next = new Map<string, Seen>();
    for (const work of activity.work()) {
      const key = keyOf(work);
      const before = previous.get(key);
      const run = seen(work, before);
      next.set(key, run);
      const completedNow =
        (running(before?.state) && completed(work.state)) ||
        (!before?.solo && !!work.soloChat && completed(work.state));
      // A publication can be acknowledged after its run ends: a quiet done
      // waits for the messages still in flight before deciding.
      const stillAwaiting =
        before?.awaiting &&
        before.startedAt === work.startedAt &&
        work.state === "done";
      if (!(completedNow || stillAwaiting) || !work.soloChat) continue;
      if (work.state === "done" && !published(work, run)) {
        if (work.publishing) next.set(key, { ...run, awaiting: true });
        continue;
      }
      const target = options.target(work);
      if (!target) continue;
      const present = (focused: boolean) => {
        if (disposed) return;
        const current = activity
          .work()
          .find(
            (item) => keyOf(item) === key && item.startedAt === work.startedAt,
          );
        if (!current || current.state !== work.state || !current.soloChat)
          return;
        if (!focused) options.desktop(current, target);
        else if (!isViewingCompletedWork(options.active(), target))
          options.foreground(current, target);
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
