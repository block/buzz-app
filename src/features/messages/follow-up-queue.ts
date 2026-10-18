import type { RelaySession } from "../relay/session";

type Activity = ReturnType<RelaySession["agentActivity"]["snapshot"]>;
type Wait = { agent: string; message?: string; turn?: string };
type Entry = {
  id: string;
  channelId: string;
  text: string;
  recipients: readonly string[];
  publish(): string;
  beforeRelease?(): Promise<void>;
  onSend?(id: string): void;
  error?: string;
};
const queues = new WeakMap<RelaySession, ReturnType<typeof createQueue>>();

/** Session-local pending sends survive navigation, like background uploads. */
export function followUpQueue(session: RelaySession) {
  let queue = queues.get(session);
  if (!queue) {
    queue = createQueue(session);
    queues.set(session, queue);
  }
  return queue;
}

function createQueue(session: RelaySession) {
  let entries: readonly Entry[] = [];
  const waits = new Map<string, Wait[]>();
  const listeners = new Set<() => void>();
  let stop: (() => void) | undefined;
  let publishing = false;
  const emit = () => {
    for (const listener of listeners) listener();
  };
  function finished(wait: Wait, activity: Activity) {
    if (wait.message) {
      const local = activity.local?.find(
        (row) => row.agent === wait.agent && row.messageId === wait.message,
      );
      if (local)
        return (
          local.state === "done" ||
          local.state === "error" ||
          local.state === "superseded"
        );
      const turns = activity.turns.filter(
        (turn) =>
          turn.agent === wait.agent &&
          turn.requests?.some((request) => request.messageId === wait.message),
      );
      return turns.length > 0 && turns.every((turn) => turn.state === "ended");
    }
    return activity.turns.some(
      (turn) =>
        turn.agent === wait.agent &&
        turn.turnId === wait.turn &&
        turn.state === "ended",
    );
  }
  function blockers(channelId: string) {
    const activity = session.agentActivity?.snapshot();
    let current = waits.get(channelId) ?? [];
    if (activity) {
      current = current.filter((wait) => !finished(wait, activity));
      const local = (activity.local ?? []).filter(
        (row) => row.channelId === channelId,
      );
      for (const row of local) {
        if (row.state === "working" || row.state === "waiting")
          current.push({ agent: row.agent, message: row.messageId });
      }
      for (const turn of activity.turns) {
        if (
          turn.channelId === channelId &&
          turn.state === "working" &&
          !local.some((row) => row.agent === turn.agent)
        )
          current.push({ agent: turn.agent, turn: turn.turnId });
      }
    }
    current = [
      ...new Map(current.map((wait) => [JSON.stringify(wait), wait])).values(),
    ];
    if (current.length) waits.set(channelId, current);
    else waits.delete(channelId);
    return current.length > 0;
  }
  function watch() {
    if (!stop && session.agentActivity) {
      const unsubscribe = session.agentActivity.subscribe(pump);
      // Keep completion evidence available even when the composer is unmounted.
      stop = unsubscribe;
      const deactivate = session.agentActivity.activate();
      stop = () => {
        unsubscribe();
        deactivate();
      };
    }
  }
  function sent(entry: Omit<Entry, "id">) {
    const id = entry.publish();
    // Include the gap between publication and the first working signal.
    waits.set(entry.channelId, [
      ...(waits.get(entry.channelId) ?? []).filter(
        (wait) => !entry.recipients.includes(wait.agent),
      ),
      ...entry.recipients.map((agent) => ({ agent, message: id })),
    ]);
    watch();
    return id;
  }
  async function release(entry: Entry) {
    if (publishing) return;
    publishing = true;
    let id: string | undefined;
    try {
      if (entry.beforeRelease) await entry.beforeRelease();
      if (!entries.includes(entry)) return;
      id = sent(entry);
      entries = entries.filter((item) => item !== entry);
    } catch (error) {
      entries = entries.map((item) =>
        item === entry
          ? {
              ...item,
              error: error instanceof Error ? error.message : String(error),
            }
          : item,
      );
    } finally {
      publishing = false;
      emit();
      queueMicrotask(pump);
    }
    // Presentation failures cannot put an already accepted message back in queue.
    if (id) entry.onSend?.(id);
  }
  function pump() {
    if (publishing) return;
    for (const channelId of new Set([
      ...waits.keys(),
      ...entries.map((entry) => entry.channelId),
    ])) {
      if (blockers(channelId)) continue;
      const first = entries.find((entry) => entry.channelId === channelId);
      if (first && !first.error) release(first);
    }
    if (!entries.length && !waits.size) {
      stop?.();
      stop = undefined;
    }
  }
  return {
    snapshot: () => entries,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    submit(entry: Omit<Entry, "id">) {
      if (
        !blockers(entry.channelId) &&
        !entries.some((item) => item.channelId === entry.channelId)
      )
        return sent(entry);
      if (entries.length >= 50)
        throw new Error(
          "The follow-up queue is full. Send or remove a queued message first.",
        );
      entries = [...entries, { ...entry, id: crypto.randomUUID() }];
      watch();
      emit();
      return undefined;
    },
    sendNow(id: string) {
      const entry = entries.find((item) => item.id === id);
      if (entry) release(entry);
    },
    remove(id: string) {
      entries = entries.filter((entry) => entry.id !== id);
      emit();
      pump();
    },
  };
}
