import { useEffect, useSyncExternalStore } from "react";
import type { WorkflowView } from "../../features/workflows/types";

/** Host factories create idle interest; the mounted consumer owns start/stop. */
export function useWorkflowView<T>(view: WorkflowView<T>) {
  const snapshot = useSyncExternalStore(
    view.subscribe,
    view.snapshot,
    view.snapshot,
  );
  useEffect(() => {
    void view.refresh();
    return () => view.dispose();
  }, [view]);
  return snapshot;
}
