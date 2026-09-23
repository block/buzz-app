import { useSyncExternalStore } from "react";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import type { AgentControl } from "./control";

export function AgentWakeNotice({ control }: { control: AgentControl }) {
  const state = useSyncExternalStore(
    control.subscribe,
    control.snapshot,
    control.snapshot,
  );
  return state.mentionError ? (
    <ToastNotice
      title="Agent could not start"
      description={state.mentionError}
      onDismiss={control.dismissMentionError}
      closeLabel="Dismiss agent notice"
    />
  ) : null;
}
