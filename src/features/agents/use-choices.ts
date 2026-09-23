import { useEffect, useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";

/** Shared candidates only. Each action retains its own access/archive policy. */
export function useAgentChoices(session: RelaySession, enabled = true) {
  const source = session.agentChoices;
  const choices = useSyncExternalStore(
    source.subscribe,
    source.snapshot,
    source.snapshot,
  );
  useEffect(() => {
    if (enabled) return source.retain();
  }, [source, enabled]);
  useEffect(() => {
    if (enabled && choices.pending) source.ensure();
  }, [source, enabled, choices.pending, choices]);
  return choices;
}
