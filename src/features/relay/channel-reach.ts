// Opening a conversation the relay lets the viewer see, whether or not it is
// in their channel list: a task's comments, or later a project channel they
// have not joined. The relay is the only judge. The app asks it, by name,
// what the viewer may do there, and never works that out itself.
//
// Each view holds its own handle; the last release forgets the grant. Reading
// and posting then use the session's ordinary windows, threads and messages,
// which the grant admits through the one discovery access check.
import {
  type ChannelAccess,
  type ChannelAccessAnswer,
  isBanned,
} from "./channel-access";
import { readErrorKind } from "./errors";

export type ChannelReachState =
  /** Asking the relay. Neither content nor a composer yet. */
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "open"; post: boolean; joined: boolean }>
  /** `unavailable`: the relay's complete answer left it out. Private, deleted
   * and never-existed look the same. `failed`: the relay could not be asked
   * or did not answer; content and posting wait, and `retry` may help.
   * `banned`: the relay refused the viewer outright; asking again won't help. */
  | Readonly<{
      status: "unavailable";
      reason: "unavailable" | "failed" | "banned";
    }>;

export type ChannelReach = Readonly<{
  snapshot(): ChannelReachState;
  subscribe(listener: () => void): () => void;
  /** Asks the relay again. */
  retry(): void;
  /** Idempotent. The last holder's release ends the grant. */
  release(): void;
}>;

export type ChannelReachHost = {
  /** The relay's access answer; undefined when it does not advertise one. */
  access?(
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<ChannelAccessAnswer>;
  /** Reads the channels' signed metadata by name. */
  resolve(ids: readonly string[], signal: AbortSignal): Promise<void>;
  /** Whether signed public metadata lets anyone read it. */
  preview(id: string): boolean;
  /** Whether the viewer's own signed membership already grants it. */
  member(id: string): boolean;
  /** While held, the relay's answer alone decides access. */
  grant(id: string, access: ChannelAccess): void;
  /** Confirmed: the relay's complete answer left it out. */
  deny(id: string): void;
  /** Uncertain: hide content and posting until the relay answers again. */
  suspend(ids: readonly string[]): void;
  /** Ends the hold: the viewer's other access decides again. */
  forget(id: string): void;
  /** What the shared access check now says, for the snapshot. */
  current(id: string): { post: boolean; joined: boolean } | undefined;
  subscribe(listener: () => void): () => void;
  signal: AbortSignal;
};

type Result = "loading" | "open" | "unavailable" | "failed" | "banned";
type Record = {
  holders: number;
  result: Result;
  /** When to ask again because a timeout in the relay's answer ends (ms). */
  due?: number | undefined;
  /** The timeout end the last answer carried (Unix seconds). */
  until?: number | undefined;
  /** Answers in a row that repeated it. */
  repeats: number;
  checking?: AbortController | undefined;
  again: boolean;
  listeners: Set<() => void>;
  state: ChannelReachState;
};

const loading: ChannelReachState = Object.freeze({ status: "loading" });
const unavailable: ChannelReachState = Object.freeze({
  status: "unavailable",
  reason: "unavailable",
});
const failed: ChannelReachState = Object.freeze({
  status: "unavailable",
  reason: "failed",
});
const banned: ChannelReachState = Object.freeze({
  status: "unavailable",
  reason: "banned",
});
/** The longest delay a timer can hold; a later end is waited for in steps. */
const LONGEST_WAIT = 2 ** 31 - 1;
/** The least wait after an answer repeats the last one's timeout end,
 * doubling with each repeat up to the most. */
const LATE_WAIT = 5_000;
const LATEST_WAIT = 300_000;

export function createChannelReach(host: ChannelReachHost) {
  const records = new Map<string, Record>();
  // One timer for the session: the earliest timeout end among held answers.
  // The relay sends nothing when a timeout runs out, so the app asks again.
  let timer: ReturnType<typeof setTimeout> | undefined;
  function schedule() {
    clearTimeout(timer);
    timer = undefined;
    let next = Infinity;
    for (const record of records.values())
      if (record.due !== undefined) next = Math.min(next, record.due);
    if (next === Infinity || host.signal.aborted) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        const now = Date.now();
        for (const [id, record] of records)
          if (record.due !== undefined && record.due <= now) {
            record.due = undefined;
            void check(id);
          }
        schedule();
      },
      Math.min(LONGEST_WAIT, Math.max(0, next - Date.now())),
    );
  }

  function project(id: string, record: Record): ChannelReachState {
    if (record.result === "loading") return loading;
    if (record.result === "failed") return failed;
    if (record.result === "banned") return banned;
    if (record.result === "unavailable") return unavailable;
    // Any other confirmed denial (a revoked live route, a refused read) also
    // reaches the shared check; it outranks the answer this handle last saw.
    const current = host.current(id);
    if (!current) return unavailable;
    const previous = record.state;
    return previous.status === "open" &&
      previous.post === current.post &&
      previous.joined === current.joined
      ? previous
      : Object.freeze({ status: "open", ...current });
  }
  function publish(id: string) {
    const record = records.get(id);
    if (!record) return;
    const next = project(id, record);
    if (next === record.state) return;
    record.state = next;
    for (const listener of [...record.listeners]) listener();
  }
  const stopHost = host.subscribe(() => {
    for (const [id, record] of records) {
      // Something else ended access (a refused read, a removal): the relay
      // decides again, and nothing shows meanwhile.
      if (record.result === "open" && !host.current(id)) {
        record.result = "loading";
        void check(id);
      }
      publish(id);
    }
  });

  type Outcome =
    | { result: "open"; access?: ChannelAccess }
    | { result: "unavailable" | "failed" | "banned"; access?: undefined };
  const readOnly: ChannelAccess = Object.freeze({ post: false, joined: false });

  /** Asks without changing anything, so a newer question can discard it. */
  async function decide(id: string, signal: AbortSignal): Promise<Outcome> {
    try {
      if (host.access) {
        const access = (await host.access([id], signal)).get(id);
        if (!access) return { result: "unavailable" };
        // Name and type for presentation; the answer already decided access.
        await host.resolve([id], signal).catch(() => {});
        return { result: "open", access };
      }
      // Without the relay's answer, only membership or public metadata
      // proves reading, and posting stays with membership.
      await host.resolve([id], signal);
      if (host.member(id)) return { result: "open" };
      if (host.preview(id)) return { result: "open", access: readOnly };
      return { result: "unavailable" };
    } catch (error) {
      signal.throwIfAborted();
      // Couldn't check is never a denial: it waits, and stays retryable.
      if (isBanned(error)) return { result: "banned" };
      return readErrorKind(error) === "denied"
        ? { result: "unavailable" }
        : { result: "failed" };
    }
  }

  async function check(id: string) {
    const record = records.get(id);
    if (!record || host.signal.aborted) return;
    if (record.checking) {
      record.again = true;
      return;
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, host.signal]);
    record.checking = controller;
    let outcome: Outcome;
    try {
      // Access changed while asking: only the newest answer counts.
      do {
        record.again = false;
        outcome = await decide(id, signal);
        signal.throwIfAborted();
      } while (record.again);
    } catch {
      return;
    } finally {
      if (record.checking === controller) record.checking = undefined;
    }
    if (records.get(id) !== record) return;
    // The result first, so the change it causes is read against it.
    record.result = outcome.result;
    // Ask again when the timeout ends. A clock running fast sees that end
    // pass while the relay still gives it: each repeat waits at least
    // longer, never back to back. A changed answer starts over.
    const until = outcome.access?.until;
    record.repeats =
      until !== undefined && until === record.until ? record.repeats + 1 : 0;
    record.until = until;
    record.due =
      until === undefined
        ? undefined
        : Date.now() +
          Math.max(
            until * 1000 - Date.now(),
            record.repeats
              ? Math.min(LATEST_WAIT, LATE_WAIT * 2 ** (record.repeats - 1))
              : 0,
          );
    schedule();
    if (outcome.result === "unavailable" || outcome.result === "banned")
      host.deny(id);
    else if (outcome.result === "failed") host.suspend([id]);
    else if (outcome.access) host.grant(id, outcome.access);
    else host.forget(id);
    publish(id);
  }

  return {
    reach(id: string): ChannelReach {
      let record = records.get(id);
      if (!record) {
        record = {
          holders: 0,
          result: "loading",
          repeats: 0,
          again: false,
          listeners: new Set(),
          state: loading,
        };
        records.set(id, record);
        void check(id);
      }
      const held = record;
      held.holders++;
      let released = false;
      const own = new Set<() => void>();
      return Object.freeze({
        snapshot: () => held.state,
        subscribe(listener: () => void) {
          if (released) return () => {};
          // One handle's listener, even when another handle shares it.
          const entry = () => listener();
          own.add(entry);
          held.listeners.add(entry);
          return () => {
            own.delete(entry);
            held.listeners.delete(entry);
          };
        },
        retry() {
          if (!released && records.get(id) === held) void check(id);
        },
        release() {
          if (released) return;
          released = true;
          for (const entry of own) held.listeners.delete(entry);
          own.clear();
          if (--held.holders > 0) return;
          held.checking?.abort();
          records.delete(id);
          schedule();
          host.forget(id);
        },
      });
    },
    /** Held and not confirmed unavailable: its sends are this owner's. */
    holds(id: string) {
      const record = records.get(id);
      return (
        !!record &&
        record.result !== "unavailable" &&
        record.result !== "banned"
      );
    },
    /** Asks again about held channels: the relay said access changed, the
     * connection came back, a live route closed, or a post was refused. */
    recheck(ids: Iterable<string> = records.keys()) {
      for (const id of [...ids]) if (records.has(id)) void check(id);
    },
    /** Hides held content and asks the relay again: a live route closed. */
    suspend(ids: readonly string[]) {
      const held = ids.filter((id) => records.has(id));
      if (!held.length) return;
      for (const id of held) {
        const record = records.get(id);
        if (record) record.result = "loading";
      }
      host.suspend(held);
      for (const id of held) void check(id);
    },
    dispose() {
      stopHost();
      clearTimeout(timer);
      for (const record of records.values()) record.checking?.abort();
      records.clear();
    },
  };
}
