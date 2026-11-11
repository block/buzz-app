import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { isSignInRefusal, type RelayRecovery } from "./recovery";
import {
  createRecoverableRead,
  isConnectivityFailure,
  type RecoverableReadState,
} from "./recoverable-read";
import type { RelaySession } from "./session";

const NONE = Object.freeze({
  recovering: false,
  attempt: 0,
  shown: false,
  reauthorized: 0,
});
const subscribeNone = () => () => {};
const snapshotNone = () => NONE;

/** Recovery state for one surface. `shown` is true while the notice is
 * visible; `recovering` is true from the first failure, including the
 * quiet RECOVERY_NOTICE_DELAY_MS before the notice appears. */
export function useRecovery(recovery: RelayRecovery | undefined) {
  const state = useSyncExternalStore(
    recovery?.subscribe ?? subscribeNone,
    recovery?.snapshot ?? snapshotNone,
    recovery?.snapshot ?? snapshotNone,
  );
  return {
    recovering: !!recovery && state.recovering,
    // Stay hidden for a failure that recovery fixes before the notice delay.
    shown: !!recovery && state.shown,
  };
}

/** Retries a finite read that recovery does not own once credentials change
 * (federated sign-in). Call `begin()` as each read starts and pass its failure
 * to the function it returns. Only a missing-sign-in refusal of a read sent
 * before the change retries, once; any other failure, or a read begun after
 * the change, stays put. Reads only: never a mutation or a user's action. */
export function useReauthorizedRetry(
  recovery: RelayRecovery | undefined,
  retry: () => void,
) {
  const latest = useRef({ recovery, retry });
  latest.current = { recovery, retry };
  /** The credential generation of the read now refused for missing sign-in. */
  const refused = useRef<number>(undefined);
  const generation = () =>
    latest.current.recovery?.snapshot().reauthorized ?? 0;
  const settle = useRef(() => {});
  settle.current = () => {
    if (refused.current === undefined || refused.current >= generation())
      return;
    refused.current = undefined;
    latest.current.retry();
  };
  useEffect(() => {
    if (!recovery) return;
    let live = true;
    const stop = recovery.subscribe(() => {
      if (live) settle.current();
    });
    return () => {
      live = false;
      refused.current = undefined;
      stop();
    };
  }, [recovery]);
  return useRef({
    begin() {
      refused.current = undefined;
      const sent = generation();
      return (error: unknown) => {
        if (!isSignInRefusal(error)) return;
        refused.current = sent;
        settle.current();
      };
    },
  }).current;
}

/** True while recovery retries this surface's own read, from its first
 * failure and through the quiet delay before the notice. The surface then
 * hides its own copy of the failure; the notice is the one report. `owns`
 * picks the read from the live view (rosterRecovering, headRecovering). A
 * failure recovery does not retry, such as a denial, stays visible even while
 * another source recovers. */
export function useRecoveryOwns(
  session: Pick<RelaySession, "recovery" | "live">,
  owns: (live: ReturnType<RelaySession["live"]["snapshot"]>) => boolean,
) {
  const { recovering } = useRecovery(session.recovery);
  const read = () => owns(session.live.snapshot());
  const owned = useSyncExternalStore(session.live.subscribe, read, read);
  return recovering && owned;
}

/** A passive read on the main surface joins the one recovery notice; see the
 * rule in recoverable-read.ts. Pass the read's current `{status, error}` (or
 * `{error, transient}`) and a function that starts it again. While the failure
 * is a connectivity failure the read registers with `recovery`, which retries
 * it on its backoff and on reconnect, focus, wake and network signals.
 *
 * `quiet` is true then: hide the surface's own error and Retry. It is also
 * true when `recovery` is undefined (a cached/offline session), where the
 * app-level notice covers the failure and the replaced session mounts reads
 * again. `failed` is the same failure without the retry-in-flight hold. `retry`
 * may be an inline closure; the latest one is used. */
export function useRecoverableRead(
  recovery: RelayRecovery | undefined,
  read: RecoverableReadState,
  retry: () => void,
) {
  const latest = useRef(retry);
  latest.current = retry;
  const controller = useMemo(
    () => createRecoverableRead(recovery, () => latest.current()),
    [recovery],
  );
  useEffect(() => () => controller.dispose(), [controller]);
  const { status, error, transient } = read;
  // Effect, not render: registering notifies recovery's subscribers.
  const quiet = useRef(false);
  useEffect(() => {
    quiet.current = controller.report({ status, error, transient });
  }, [controller, status, error, transient]);
  const failed = isConnectivityFailure(read);
  // A retry in flight after a failure stays quiet; the controller holds that.
  return { failed, quiet: failed || (status === "loading" && quiet.current) };
}

export const RECOVERY_TITLE = "Buzz is having trouble connecting";

/** The one relay recovery notice, on every page. Recovery retries on its own,
 * so it offers no button. */
export function RecoveryNotice({
  recovery,
}: {
  recovery: RelayRecovery | undefined;
}) {
  const { shown } = useRecovery(recovery);
  if (!shown) return null;
  return (
    <ToastNotice
      title={RECOVERY_TITLE}
      description="Retrying automatically."
      tone="info"
    />
  );
}
