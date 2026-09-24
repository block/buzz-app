import { MembershipChanged } from "./members";
import type { AgentControl } from "../agents/control";

type Addition = Readonly<{
  channelId: string;
  pubkey: string;
  pending: boolean;
  confirmed: boolean;
  error?: string;
  removed?: boolean;
  superseded?: readonly string[];
}>;

/** Session-owned continuation and recovery; closing a view never cancels intent. */
export function createMemberAdditions(
  signal: AbortSignal,
  add: (
    channelId: string,
    pubkey: string,
    superseded: readonly string[],
  ) => Promise<void>,
  start: (
    channelId: string,
    pubkey: string,
    control: AgentControl | undefined,
    retryStart: boolean,
  ) => Promise<void>,
) {
  let snapshot: readonly Addition[] = [];
  const listeners = new Set<() => void>();
  const pending = new Map<string, Promise<void>>();
  function publish(next: readonly Addition[]) {
    snapshot = next;
    for (const listener of listeners) listener();
  }
  signal.addEventListener(
    "abort",
    () => {
      publish([]);
      listeners.clear();
    },
    { once: true },
  );
  return Object.freeze({
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    add(
      channelId: string,
      pubkey: string,
      control?: AgentControl,
    ): Promise<void> {
      if (signal.aborted)
        return Promise.reject(new Error("The community connection closed."));
      const key = JSON.stringify([channelId, pubkey]);
      const existing = pending.get(key);
      if (existing) return existing;
      const matches = (item: Addition) =>
        item.channelId === channelId && item.pubkey === pubkey;
      const previous = snapshot.find(matches);
      let confirmed = previous?.confirmed ?? false;
      const update = (item?: Addition) => {
        if (!signal.aborted)
          publish([
            ...snapshot.filter((value) => !matches(value)),
            ...(item ? [item] : []),
          ]);
      };
      const operation = Promise.resolve()
        .then(async () => {
          signal.throwIfAborted();
          const retryStart = confirmed;
          if (!confirmed) {
            await add(channelId, pubkey, previous?.superseded ?? []);
            confirmed = true;
          }
          signal.throwIfAborted();
          await start(channelId, pubkey, control, retryStart);
          update();
        })
        .catch((error: unknown) => {
          update({
            channelId,
            pubkey,
            pending: false,
            confirmed: error instanceof MembershipChanged ? false : confirmed,
            removed: error instanceof MembershipChanged,
            superseded:
              error instanceof MembershipChanged
                ? [...(previous?.superseded ?? []), ...error.superseded]
                : (previous?.superseded ?? []),
            error:
              error instanceof Error
                ? error.message
                : "Could not add this member. Try again.",
          });
          throw error;
        })
        .finally(() => {
          pending.delete(key);
        });
      pending.set(key, operation);
      update({ channelId, pubkey, pending: true, confirmed });
      return operation;
    },
  });
}
