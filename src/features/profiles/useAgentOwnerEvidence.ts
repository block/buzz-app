import { useEffect, useState, useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import {
  type AgentOwnerEvidence,
  createAgentOwnerEvidence,
} from "./agent-owner-evidence";

const none: AgentOwnerEvidence = Object.freeze({
  status: "unavailable" as const,
  owner: undefined,
  failed: false,
  settled: true,
});

/** Verified NIP-OA owner of the winning signed kind 0, or none. Agent hints
 * decide whether to mount this view; they never establish ownership.
 * Private admission must inspect readiness as well as signed-head ownership.
 * Public identity attribution may still display its retained signed evidence.
 * The rule lives in `createAgentOwnerEvidence`; this renders it. */
export function useAgentOwnerEvidence(
  session: RelaySession,
  pubkey: string | undefined,
  attempt = 0,
): AgentOwnerEvidence {
  // A session-owned view: live events, reconnect refresh and purge, no polling.
  // Capacity or a closed session leaves no view; profile recovery retries.
  const [store, setStore] =
    useState<ReturnType<typeof createAgentOwnerEvidence>>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt retries view admission.
  useEffect(() => {
    const next = createAgentOwnerEvidence(session, pubkey);
    setStore(next);
    return () => next.dispose();
  }, [session, pubkey, attempt]);
  return useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    store?.snapshot ?? (() => (pubkey ? loading : none)),
    store?.snapshot ?? (() => (pubkey ? loading : none)),
  );
}
const noSubscribe = () => () => {};
const loading: AgentOwnerEvidence = Object.freeze({
  status: "loading" as const,
  owner: undefined,
  failed: false,
  settled: false,
});
