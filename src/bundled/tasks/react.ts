import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import type {
  ChannelReach,
  ChannelReachState,
} from "../../features/relay/channel-reach";
import type { ChannelSummary } from "../../features/relay/contracts";
import { useChannelRoster } from "../../features/relay/react";
import type { Task } from "./model";
import { canHoldTasks, type Place, readPlaces } from "./places";
import { type TasksState, type TasksView, watchTasks } from "./store";

const loading: TasksView = {
  snapshot: () => ({ status: "loading", tasks: [] }) satisfies TasksState,
  subscribe: () => () => {},
  dispose: () => {},
};

/** One live view per session, shared by the page, panels and task links,
 * and closed when the last of them unmounts. */
const shared = new WeakMap<RelaySession, { view: TasksView; users: number }>();

function acquire(session: RelaySession) {
  const entry = shared.get(session) ?? { view: watchTasks(session), users: 0 };
  entry.users += 1;
  shared.set(session, entry);
  return {
    view: entry.view,
    release() {
      entry.users -= 1;
      if (entry.users > 0) return;
      shared.delete(session);
      entry.view.dispose();
    },
  };
}

/** Every current task the viewer can read, live while mounted. */
export function useTasks(session: RelaySession | undefined): TasksState {
  const [view, setView] = useState<TasksView>(loading);
  useEffect(() => {
    if (!session) {
      setView(loading);
      return;
    }
    const held = acquire(session);
    setView(held.view);
    return held.release;
  }, [session]);
  return useSyncExternalStore(view.subscribe, view.snapshot, view.snapshot);
}

/** Tasks from the live view, with this device's saves shown until the
 * relay's copy has them: the same revision, or a strictly newer one. A tie
 * keeps the save, the newest this device knows of. */
export function useTasksWithSaved(session: RelaySession) {
  const state = useTasks(session);
  const [saved, setSavedMap] = useState<ReadonlyMap<string, Task>>(new Map());
  const setSaved = useCallback(
    (task: Task) =>
      setSavedMap((current) => new Map(current).set(task.id, task)),
    [],
  );
  const tasks = useMemo(() => {
    if (!saved.size) return state.tasks;
    const live = new Map(state.tasks.map((task) => [task.id, task]));
    for (const task of saved.values()) {
      const current = live.get(task.id);
      if (
        !current ||
        (current.revision !== task.revision &&
          current.updatedAt <= task.updatedAt)
      )
        live.set(task.id, task);
    }
    return [...live.values()];
  }, [state.tasks, saved]);
  return { ...state, tasks, setSaved };
}

/** Names, kinds and projects of `ids`, read once per distinct set. Places
 * not yet read are absent; a failed read leaves them unnamed. */
export function usePlaces(
  session: RelaySession,
  ids: readonly string[],
): ReadonlyMap<string, Place> {
  const key = [...new Set(ids)].sort().join(",");
  const [places, setPlaces] = useState<ReadonlyMap<string, Place>>(new Map());
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    readPlaces(session, key.split(","), controller.signal).then(
      (read) =>
        !controller.signal.aborted &&
        setPlaces((current) => new Map([...current, ...read])),
      () => {},
    );
    return () => controller.abort();
  }, [session, key]);
  return places;
}

/** Listed places a task can live in, by the one rule (`canHoldTasks`).
 * Whether the viewer may post there is the relay's answer
 * (`usePlaceAccess`), never this list's. */
export const isTaskPlace = (channel: ChannelSummary) =>
  !channel.pending &&
  canHoldTasks({
    type: channel.channelType,
    huddle: channel.huddle,
    archived: channel.archived,
  });

/** The places the viewer knows of, those this device already knows they can
 * post in first. */
export function useTaskPlaces(session: RelaySession) {
  const { channels } = useChannelRoster(session.channels);
  return useMemo(
    () =>
      channels
        .filter(isTaskPlace)
        .sort((a, b) => Number(!!a.readOnly) - Number(!!b.readOnly)),
    [channels],
  );
}

/** What the viewer may do with tasks in a place, from the relay's answer:
 * `edit` where they can post, `view` where they can only read. `loading`
 * and `failed` show neither edit controls nor a read-only notice yet. */
export type PlaceAccess = "loading" | "edit" | "view" | "none" | "failed";

const asking: ChannelReachState = Object.freeze({ status: "loading" });
const quiet = () => () => {};

/** Holds channel `id` open while mounted, and the relay's answer for it. */
export function useReach(session: RelaySession, id: string | undefined) {
  const [handle, setHandle] = useState<ChannelReach>();
  useEffect(() => {
    const reach = session.channels.reach;
    if (!id || !reach) return;
    const held = reach(id);
    setHandle(held);
    return () => {
      held.release();
      setHandle(undefined);
    };
  }, [session, id]);
  const read = () => handle?.snapshot() ?? asking;
  const state = useSyncExternalStore(handle?.subscribe ?? quiet, read, read);
  return { state, retry: () => handle?.retry() };
}

export const accessOf = (state: ChannelReachState): PlaceAccess =>
  state.status === "open"
    ? state.post
      ? "edit"
      : "view"
    : state.status === "unavailable"
      ? state.reason === "failed"
        ? "failed"
        : "none"
      : "loading";

/** The viewer's access to tasks in `id`. A connection that can't ask the
 * relay by name falls back to its channel list's posting answer. */
export function usePlaceAccess(
  session: RelaySession,
  id: string | undefined,
): Readonly<{ access: PlaceAccess; retry(): void }> {
  const reach = useReach(session, id);
  const { channels } = useChannelRoster(session.channels);
  if (session.channels.reach)
    return { access: accessOf(reach.state), retry: reach.retry };
  const listed = channels.find((channel) => channel.id === id);
  return {
    access: !listed ? "none" : listed.readOnly ? "view" : "edit",
    retry: () => {},
  };
}
