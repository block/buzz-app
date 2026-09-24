import { useEffect, useSyncExternalStore } from "react";
import type { AgentControl } from "./control";

/** View lifetime owns observation only; native execution remains app-owned. */
export function useAgentControl(control: AgentControl) {
  const state = useSyncExternalStore(
    control.subscribe,
    control.snapshot,
    control.snapshot,
  );
  useEffect(() => {
    void control.refresh();
    const timer = setInterval(() => {
      if (
        document.visibilityState !== "hidden" &&
        control.snapshot().status === "ready"
      )
        void control.refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [control]);
  return state;
}
