import { useEffect, useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";

/** Shared candidates only. Ordinary mentions observe legacy hints without loading
 * them; native inventory is still ensured through the app-owned controller. */
export function useAgentChoices(session: RelaySession, includeLegacy = true) {
  const source = session.agentChoices;
  const choices = useSyncExternalStore(
    source.subscribe,
    source.snapshot,
    source.snapshot,
  );
  useEffect(() => {
    if (includeLegacy) return source.retain();
  }, [source, includeLegacy]);
  useEffect(() => {
    if (choices.pending) source.ensure(includeLegacy);
  }, [source, includeLegacy, choices.pending, choices]);
  return choices;
}
