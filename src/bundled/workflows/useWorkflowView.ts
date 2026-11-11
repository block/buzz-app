import { useMemo, useSyncExternalStore } from "react";
import { useRecoverableRead } from "../../features/relay/RecoveryNotice";
import type { RelayRecovery } from "../../features/relay/recovery";
import type { WorkflowView } from "../../features/workflows/types";

/** Allocate host interest on subscription, not render. StrictMode may discard a
 * render or unsubscribe/resubscribe without constructing a new component. */
export function useWorkflowView<T>(
  create: () => WorkflowView<T>,
  recovery?: RelayRecovery,
) {
  const store = useMemo(() => {
    let view: WorkflowView<T> | undefined;
    return {
      snapshot: () => view?.snapshot(),
      refresh: () => view?.refresh() ?? Promise.resolve(),
      subscribe(listener: () => void) {
        const owned = create();
        view = owned;
        const stop = owned.subscribe(listener);
        void owned.refresh();
        return () => {
          stop();
          owned.dispose();
          if (view === owned) view = undefined;
        };
      },
    };
  }, [create]);
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.snapshot,
  );
  // A connectivity failure belongs to the app's one recovery notice, which
  // retries the read on its own. Meanwhile the view reads as loading, so the
  // page shows neither its own error nor a Retry; other failures stay put.
  const { quiet } = useRecoverableRead(
    recovery,
    snapshot ?? {},
    () => void store.refresh(),
  );
  const shown =
    snapshot && quiet && snapshot.status === "error"
      ? (({ error: _failure, ...rest }) => ({
          ...rest,
          status: "loading" as const,
        }))(snapshot)
      : snapshot;
  return { snapshot: shown, refresh: store.refresh };
}
