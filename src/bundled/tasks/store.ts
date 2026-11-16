// Reading and saving tasks. Each task lives in its home; reads ask the relay
// for every task the viewer can read, wherever it lives, and the relay alone
// decides that. Saves are compare-and-set on the revision the editor opened,
// so a concurrent edit is reported, never overwritten.
import {
  ARTIFACT_KIND,
  deliver,
} from "../../features/agents/agent-config-artifacts";
import type { RelayEvent } from "../../features/relay/events";
import type { RelaySession } from "../../features/relay/session";
import {
  checkedFields,
  TASK_TYPE,
  type Task,
  type TaskFields,
  type TaskStatus,
  taskContent,
  taskOf,
  taskTags,
} from "./model";
import { canHoldTasks, readPlaces } from "./places";

export type TasksState = Readonly<{
  status: "loading" | "live" | "error";
  tasks: readonly Task[];
  error?: string | undefined;
}>;

export type TasksView = Readonly<{
  snapshot(): TasksState;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}>;

/** The session reader's cap on one finite read. */
const READ_LIMIT = 500;

const taskFilter = { kinds: [ARTIFACT_KIND], "#type": [TASK_TYPE] };

const toTasks = (events: readonly RelayEvent[]) =>
  events.flatMap((event) => taskOf(event) ?? []);

/** Every current task the viewer can read, kept current while subscribed. */
export function watchTasks(session: RelaySession): TasksView {
  const listeners = new Set<() => void>();
  let state: TasksState = { status: "loading", tasks: [] };
  const set = (next: TasksState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const sync = session.artifacts.sync({
    artifact: "current" as const,
    ...taskFilter,
  });
  let fallback: AbortController | undefined;
  // A relay without sync gets one finite read; saves on this device still
  // show through `saved`.
  const readOnce = () => {
    if (fallback) return;
    if (!session.snapshotRead) {
      set({
        status: "error",
        tasks: [],
        error: "Tasks aren’t available in this community.",
      });
      return;
    }
    const controller = new AbortController();
    fallback = controller;
    readTasks(session, controller.signal)
      .then(({ tasks }) => {
        if (!controller.signal.aborted) set({ status: "live", tasks });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          set({
            status: "error",
            tasks: state.tasks,
            error:
              reason instanceof Error ? reason.message : "Couldn’t load tasks.",
          });
      });
  };
  const apply = () => {
    const current = sync.snapshot();
    switch (current.status) {
      case "unsupported":
        readOnce();
        return;
      case "live":
      case "stale":
        set({ status: "live", tasks: toTasks(current.events) });
        return;
      case "restricted":
      case "error":
        set({
          status: "error",
          tasks: toTasks(current.events),
          error: current.error ?? "Couldn’t load tasks.",
        });
        return;
      case "loading":
        return;
    }
  };
  const stop = sync.subscribe(apply);
  apply();
  return {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    dispose() {
      stop();
      sync.dispose();
      fallback?.abort();
      listeners.clear();
    },
  };
}

/** What a finite read asks the relay for: each set matches any of its
 * values, and all of them must match. */
export type TaskQuery = Readonly<{
  status?: readonly TaskStatus[] | undefined;
  /** A person's pubkey, or `null` for tasks nobody has. */
  assignee?: string | null | undefined;
  /** A place: its tasks, and for a project everything filed in it. */
  within?: string | undefined;
}>;

/** Where task reads come from: a session, or an agent's own reads. */
export type TaskSource = Pick<RelaySession, "snapshotRead" | "relayAuthor">;

/** One finite read of the current tasks the viewer can read that match
 * `query`, filtered by the relay. `complete` is false when the read hit its
 * cap, so more may match. */
export async function readTasks(
  session: TaskSource,
  signal: AbortSignal,
  query: TaskQuery = {},
): Promise<Readonly<{ tasks: readonly Task[]; complete: boolean }>> {
  const read = session.snapshotRead;
  if (!read) throw new Error("Tasks aren’t available in this community.");
  const events = await read(
    [
      {
        artifact: "current",
        ...taskFilter,
        ...(query.status?.length ? { "#status": [...query.status] } : {}),
        ...(query.assignee
          ? { "#assignee": [query.assignee] }
          : query.assignee === null
            ? { unassigned: true }
            : {}),
        ...(query.within ? { within: query.within } : {}),
        limit: READ_LIMIT,
      },
    ],
    { signal },
  );
  return { tasks: toTasks(events), complete: events.length < READ_LIMIT };
}

/** Task `id`'s current revision, or undefined when the viewer can't read it
 * or it was deleted. `home`, when known, names its home, so a task readable
 * only by naming its home is found too. */
export async function readTask(
  session: TaskSource,
  id: string,
  signal: AbortSignal,
  home?: string,
): Promise<Task | undefined> {
  const read = session.snapshotRead;
  if (!read) throw new Error("Tasks aren’t available in this community.");
  const events = await read(
    [
      {
        artifact: "current",
        ...taskFilter,
        "#d": [id],
        ...(home ? { "#h": [home] } : {}),
        limit: 2,
      },
    ],
    { signal },
  );
  const tasks = toTasks(events).filter((task) => task.id === id);
  // A moved task named by its old home reads as missing; ask without it.
  if (!tasks.length && home) return readTask(session, id, signal);
  return tasks.length === 1 ? tasks[0] : undefined;
}

export type SaveResult =
  | Readonly<{ status: "saved"; task: Task }>
  /** Someone else saved first; `current` is their version, the next base. */
  | Readonly<{ status: "conflict"; current: Task }>;

/** What a save does: create task `id` in `home`, update `base` where it
 * lives, or move `base` to `home` with `fields` as its snapshot. */
export type SaveTarget =
  /** `via`: the agent making it for the viewer, shown as a label. */
  | Readonly<{ op: "create"; home: string; id: string; via?: string }>
  | Readonly<{ op: "update"; base: Task }>
  | Readonly<{ op: "move"; base: Task; home: string }>;

export const NOT_A_TASK_PLACE =
  "A task can live in a project, channel or chat that isn’t archived, never a DM or a huddle. Nothing was saved.";

/** Saves one revision, signed by the session's viewer. A new task's caller
 * keeps one `id` across retries, so a create that landed unseen is found, not
 * made twice. Whatever the save reads back, to see whose revision won, comes
 * through `reader` alone: an agent's tool passes the agent's own reads. */
export async function saveTask(
  session: RelaySession,
  reader: TaskSource,
  fields: TaskFields,
  target: SaveTarget,
  signal: AbortSignal = AbortSignal.timeout(20_000),
): Promise<SaveResult> {
  const writer = session.configArtifactWriter;
  const viewer = session.viewer;
  if (!session.snapshotRead || !writer || !viewer)
    throw new Error("This community connection can’t save tasks.");
  const checked = checkedFields(fields);
  const base = target.op === "create" ? undefined : target.base;
  const id = base?.id ?? (target.op === "create" ? target.id : "");
  const home = target.op === "update" ? target.base.home : target.home;
  // The signer of the first revision, carried forward as the relay checks.
  const creator = base ? base.creator : viewer;
  const via = base ? base.via : target.op === "create" ? target.via : undefined;
  // Every screen and tool creates and moves through here, so this is where
  // the rule for where a task can live is kept.
  if (target.op !== "update") {
    const place = (await readPlaces(reader, [home], signal)).get(home);
    if (!place) throw new Error("You can’t see that place. Nothing was saved.");
    if (!canHoldTasks(place)) throw new Error(NOT_A_TASK_PLACE);
  }
  const event = await writer.sign(
    {
      kind: ARTIFACT_KIND,
      created_at: Math.floor(Date.now() / 1000),
      content: taskContent(checked),
      tags: [
        ["ar", "1"],
        ["d", id],
        ["h", home],
        ["type", TASK_TYPE],
        ["title", checked.title],
        ["op", target.op],
        ...(base ? [["prev", base.revision]] : []),
        ...taskTags(checked),
        ...(creator ? [["creator", creator]] : []),
        ...(via ? [["via", via]] : []),
      ],
    },
    signal,
  );
  const delivery = await deliver(writer, event, signal);
  if (delivery.status === "accepted") {
    const task = taskOf(event);
    if (!task) throw new Error("Couldn’t read the saved task.");
    return { status: "saved", task };
  }
  if (
    (delivery.status === "refused" && delivery.refusal === "conflict") ||
    delivery.status === "uncertain"
  ) {
    // The head shows whether this revision landed, or whose did instead.
    const current = await readTask(reader, id, signal, home).catch(
      () => undefined,
    );
    if (current?.revision === event.id)
      return { status: "saved", task: current };
    if (delivery.status === "refused" && current)
      return { status: "conflict", current };
    if (delivery.status === "refused")
      throw new Error(
        "Someone else changed or removed this task. Nothing was saved.",
      );
  }
  throw new Error(
    delivery.status === "refused" && delivery.refusal === "permission"
      ? target.op === "move"
        ? "You can only move a task between places you can post in."
        : "You can only view tasks here."
      : delivery.status === "refused" && delivery.refusal === "too-large"
        ? "This task is too large to save. Shorten the description."
        : // The relay's own reason, such as an assignee who can't see it.
          delivery.status === "refused" && delivery.refusal === "invalid"
          ? `Couldn’t save the task: ${delivery.message}`
          : "Couldn’t save the task. Try again.",
  );
}
