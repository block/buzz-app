// Keeps each member's install records in step with the plugins they have,
// wherever those came from, in whichever community they are signed in to.
import type { InstalledPlugin } from "../../features/plugin-inventory/service";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
  CountsUnavailable,
  ensureChannel,
  findChannel,
  MAX_RECONCILE,
  readOwn,
  reconcile,
  writeRecord,
} from "./community-counts";

/** Each community's saved choice, by session scope: `{ [scope]: boolean }`. */
export const RECORD_KEY = "buzz.community-plugins.record.v2";
const RETRY_MS = 30_000;

export type Inventory = Readonly<{
  installed(): readonly InstalledPlugin[] | undefined;
  subscribe(listener: () => void): () => void;
}>;

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export type Recorder = Readonly<{
  /** Whether the selected community records the viewer's plugins. */
  recording(): boolean;
  /** Saves the selected community's choice, then withdraws or restores the
   * viewer's records there. Rejects when that didn't finish; it is retried. */
  setRecording(on: boolean): Promise<void>;
  /** Brings the current community's records in line now. Rejects when that
   * didn't finish; it is retried. */
  sync(): Promise<void>;
  /** Runs one of the viewer's own record writes, such as an upvote, while
   * recording is on, so turning recording off waits for it. Resolves
   * undefined without running it while recording is off. */
  write<T>(task: (session: RelaySession) => Promise<T>): Promise<T | undefined>;
  /** Tells the recorder which channel the counts were read from, so it
   * records there when that differs from where it last did. */
  sawChannel(channel: string): void;
  /** Called after the recorder wrote records. */
  subscribe(listener: () => void): () => void;
  stop(): void;
}>;

const readyPage = (relay: RelayData): RelaySession | undefined => {
  const snapshot = relay.snapshot();
  return snapshot?.status === "ready" ? snapshot.session : undefined;
};

function defaultStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

class Superseded extends Error {}

export function createRecorder({
  relay,
  inventory,
  listed,
  storage = defaultStorage(),
  delayMs = 2_000,
  retryMs = RETRY_MS,
}: Readonly<{
  relay: RelayData;
  inventory: Inventory;
  /** Manifest ids the community index lists. Only those are recorded. */
  listed: () => Promise<ReadonlySet<string>>;
  storage?: Storage | undefined;
  delayMs?: number;
  retryMs?: number;
}>): Recorder {
  const listeners = new Set<() => void>();
  const done = new WeakMap<
    RelaySession,
    { fingerprint: string; channel: string | undefined }
  >();
  // Choices made this run win over storage, so a failed save still holds.
  const chosen = new Map<string, boolean>();
  const writes = new Set<Promise<unknown>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  let stopped = false;

  const saved = (): Record<string, unknown> => {
    try {
      const parsed = JSON.parse(storage?.getItem(RECORD_KEY) ?? "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  };

  const recordingIn = (session: RelaySession | undefined) => {
    if (!session) return false;
    const choice = chosen.get(session.scope) ?? saved()[session.scope];
    return typeof choice === "boolean" ? choice : true;
  };

  const notify = () => {
    for (const listener of listeners) listener();
  };

  async function once(force: boolean) {
    const session = readyPage(relay);
    const everything = inventory.installed();
    if (!session || !everything) return;
    const on = recordingIn(session);
    let wrote = false;
    let fingerprint = "";
    try {
      const ids = on ? await listed() : new Set<string>();
      const installed = everything.filter((plugin) => ids.has(plugin.id));
      fingerprint = JSON.stringify([
        on,
        [...installed].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      ]);
      if (!force && done.get(session)?.fingerprint === fingerprint) return;
      const channel =
        on && installed.length
          ? await ensureChannel(session)
          : await findChannel(session);
      if (!channel) {
        done.set(session, { fingerprint, channel: undefined });
        return;
      }
      const changes = reconcile(
        await readOwn(session, channel.id),
        installed,
        on,
      );
      for (const change of changes) {
        if (stopped || readyPage(relay) !== session) return;
        if (recordingIn(session) !== on) throw new Superseded();
        if (
          await writeRecord(
            session,
            channel.id,
            change.type,
            change.id,
            change.on,
            { source: change.source },
          )
        )
          wrote = true;
      }
      if (changes.length < MAX_RECONCILE)
        done.set(session, { fingerprint, channel: channel.id });
      else again = true;
    } catch (error) {
      if (error instanceof Superseded) {
        again = true;
        return;
      }
      // A community that can't keep counts stays quiet.
      if (error instanceof CountsUnavailable) {
        done.set(session, { fingerprint, channel: undefined });
        return;
      }
      if (!stopped) {
        clearTimeout(retry);
        retry = setTimeout(() => void run(false).catch(() => {}), retryMs);
      }
      throw error;
    } finally {
      if (wrote) notify();
    }
  }

  function run(force: boolean): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = once(force).finally(() => {
      running = undefined;
      if (again && !stopped) {
        again = false;
        schedule();
      }
    });
    return running;
  }

  function schedule() {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => void run(false).catch(() => {}), delayMs);
  }

  async function settle() {
    clearTimeout(timer);
    await Promise.allSettled([running, ...writes]);
  }

  const unsubscribe = [
    relay.subscribe(schedule),
    inventory.subscribe(schedule),
  ];
  schedule();

  return {
    recording: () => recordingIn(readyPage(relay)),
    async setRecording(on) {
      const session = readyPage(relay);
      if (!session) return;
      chosen.set(session.scope, on);
      try {
        storage?.setItem(
          RECORD_KEY,
          JSON.stringify({ ...saved(), [session.scope]: on }),
        );
      } catch {}
      await settle();
      await run(true);
    },
    async sync() {
      await settle();
      await run(true);
    },
    async write(task) {
      const session = readyPage(relay);
      if (!session || !recordingIn(session)) return undefined;
      const pending = task(session);
      writes.add(pending);
      try {
        return await pending;
      } finally {
        writes.delete(pending);
        if (!recordingIn(session)) {
          done.delete(session);
          schedule();
        }
      }
    },
    sawChannel(channel) {
      const session = readyPage(relay);
      const last = session && done.get(session);
      if (!session || !last || last.channel === channel) return;
      done.delete(session);
      schedule();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(retry);
      for (const stop of unsubscribe) stop();
      listeners.clear();
    },
  };
}
