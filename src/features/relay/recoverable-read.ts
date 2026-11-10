/** Passive reads on the main surface share ONE disconnect error.
 *
 * On the shell, sidebar, channel pages, Activity, plugin pages and the pickers
 * and popovers over them, a connectivity failure (isTransientFailure: network,
 * timeout, 408/429/5xx, native transport strings) shows only the recovery
 * notice ("Buzz is having trouble connecting"). A passive read is anything the
 * app loads by itself, not a user action. It must not show its own disconnect
 * error or Retry; it joins session recovery, which retries it on a backoff and
 * at once when the connection returns. User actions (send, save, delete) keep
 * their own errors, and so do denials, other 4xx and malformed responses.
 * Settings, onboarding and other surfaces outside the main surface are exempt.
 *
 * React surfaces call `useRecoverableRead` (RecoveryNotice.tsx); stores that
 * own a read outside React call `createRecoverableRead` here. Both hide the
 * surface's error when `quiet` is true, including when `recovery` is
 * undefined: a cached/offline session has no transport and no recovery, and
 * the app-level notice covers it until the service replaces the session. */
import { isRetryableRead } from "./read-retry";
import type { RecoverySource, RecoveryStatus, RelayRecovery } from "./recovery";

/** A read's state. `transient` overrides classifying `error`, for stores that
 * keep only an error string (see loadState). */
export type RecoverableReadState = Readonly<{
  status?: string | undefined;
  error?: unknown;
  transient?: boolean | undefined;
}>;

/** True when the read's current failure is a connectivity failure. A read that
 * is loading again has no current failure. */
export function isConnectivityFailure(state: RecoverableReadState) {
  if (state.status === "loading") return false;
  if (state.status !== undefined && state.status !== "error") return false;
  if (state.error === undefined || state.error === null) return false;
  return state.transient ?? isRetryableRead(state.error);
}

export type RecoverableRead = Readonly<{
  /** Reports the read's latest state; call on every change. Returns `quiet`:
   * true while the failure belongs to the app-level notice, so the owner hides
   * its own error and Retry. */
  report(state: RecoverableReadState): boolean;
  /** Unregisters from recovery. A later `report` joins again. */
  dispose(): void;
}>;

/** Joins `recovery` while the read has a connectivity failure and stays joined
 * while its retry runs, so the notice survives the retry; leaves once the read
 * settles. `retry` is called for every recovery retry: pass a function that
 * starts the read again and reads current state, not a stale closure. */
export function createRecoverableRead(
  recovery: RelayRecovery | undefined,
  retry: () => void,
): RecoverableRead {
  let status: RecoveryStatus = "settled";
  let leave: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const source: RecoverySource = {
    status: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry: () => retry(),
  };
  const set = (next: RecoveryStatus) => {
    if (next === status) return;
    status = next;
    for (const listener of [...listeners]) listener();
  };
  const settle = () => {
    set("settled");
    leave?.();
    leave = undefined;
  };
  return {
    report(state) {
      const failed = isConnectivityFailure(state);
      if (failed) {
        set("failed");
        if (recovery && !leave) leave = recovery.register(source);
      } else if (status !== "settled" && state.status === "loading")
        set("busy");
      else settle();
      return failed || status === "busy";
    },
    dispose: settle,
  };
}
