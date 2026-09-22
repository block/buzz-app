import { useSyncExternalStore } from "react";
import type { AgentControl } from "./control";

export function AgentWakeNotice({ control }: { control: AgentControl }) {
  const state = useSyncExternalStore(
    control.subscribe,
    control.snapshot,
    control.snapshot,
  );
  return state.mentionError ? (
    <div role="alert" className="notice">
      <p>{state.mentionError}</p>
      <button type="button" onClick={control.dismissMentionError}>
        Dismiss agent notice
      </button>
    </div>
  ) : null;
}
