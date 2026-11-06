import { attestedOwner } from "../agents/owner-attestation";
import { type EventData, newer } from "../relay/events";
import type { EventViewSnapshot, RelaySession } from "../relay/session";

type ProfileView = ReturnType<RelaySession["observe"]>;
export type AgentOwnerEvidence = Readonly<{
  status: "loading" | "ready" | "error" | "unavailable";
  /** Verified NIP-OA owner of the winning signed kind 0, once settled. */
  owner: string | undefined;
  failed: boolean;
  settled: boolean;
}>;
const pendingSnapshot: EventViewSnapshot = Object.freeze({
  status: "loading",
  events: [],
});

/**
 * The owner-evidence rule, as a store: observe the agent's signed kind 0
 * through a session view, take the newest non-failed head (the directory's
 * retained head included, so a reopened observation cannot accept an older
 * response than the rest of the session shows), verify its attestation
 * asynchronously, and admit the result only while the view is ready and the
 * verified id is the current head; a new head, purge or failed read must
 * establish it anew. Agent hints decide whether to observe; they never
 * establish ownership. `useAgentOwnerEvidence` renders this store.
 */
export function createAgentOwnerEvidence(
  session: RelaySession,
  pubkey: string | undefined,
) {
  const listeners = new Set<() => void>();
  let view: ProfileView | null | undefined;
  let stopView: (() => void) | undefined;
  let stopProfiles: (() => void) | undefined;
  let verified: { id: string; owner?: string } | undefined;
  let verifying: string | undefined;
  let admitted: { view: ProfileView; id: string } | undefined;
  let snapshot: AgentOwnerEvidence = compute();
  let disposed = false;
  const emit = () => {
    const next = compute();
    if (
      next.status === snapshot.status &&
      next.owner === snapshot.owner &&
      next.failed === snapshot.failed &&
      next.settled === snapshot.settled
    )
      return;
    snapshot = next;
    for (const listener of listeners) listener();
  };
  function events(): EventViewSnapshot {
    return view?.snapshot() ?? pendingSnapshot;
  }
  function latestHead(): EventData | undefined {
    if (!view || !pubkey) return undefined;
    const head = session.profiles.event?.(pubkey);
    return events()
      .events.filter(
        (event) =>
          event.kind === 0 &&
          event.pubkey === pubkey &&
          event.delivery !== "failed",
      )
      .reduce<EventData | undefined>(newer, head);
  }
  function compute(): AgentOwnerEvidence {
    const current = events();
    const latest = latestHead();
    const settledHead = !!(verified && latest && verified.id === latest.id);
    // Only an already admitted result from this observation may survive a
    // background read. New heads, purges and failed reads establish anew.
    if (current.status === "ready" && view && latest && settledHead) {
      admitted =
        admitted?.view === view && admitted.id === latest.id
          ? admitted
          : { view, id: latest.id };
    } else if (
      !(
        current.status === "loading" &&
        admitted?.view === view &&
        admitted?.id === latest?.id
      )
    )
      admitted = undefined;
    const refreshingAdmittedHead =
      !!admitted &&
      current.status === "loading" &&
      admitted.view === view &&
      admitted.id === latest?.id;
    const status: AgentOwnerEvidence["status"] =
      view === null
        ? "unavailable"
        : current.status === "error"
          ? "error"
          : !view ||
              (current.status !== "ready" && !refreshingAdmittedHead) ||
              (latest && verified?.id !== latest.id)
            ? "loading"
            : "ready";
    return {
      status,
      owner: settledHead ? verified?.owner : undefined,
      failed: !!pubkey && (view === null || current.status === "error"),
      // An absent event is conclusive only after its read completed. Failure
      // or exhausted capacity must not unlock unverified legacy fallback.
      settled:
        !pubkey ||
        settledHead ||
        (!!view && !latest && current.status === "ready"),
    };
  }
  function verify() {
    const latest = latestHead();
    if (!latest || verifying === latest.id || verified?.id === latest.id)
      return;
    verifying = latest.id;
    void attestedOwner(latest).then((owner) => {
      if (disposed || verifying !== latest.id) return;
      verifying = undefined;
      verified = { id: latest.id, ...(owner ? { owner } : {}) };
      emit();
    });
  }
  function changed() {
    if (disposed) return;
    verify();
    if (events().status === "idle") void view?.refresh();
    emit();
  }
  function observe() {
    stopView?.();
    stopView = undefined;
    if (!pubkey) {
      view = null;
      return;
    }
    try {
      view = session.observe([{ kinds: [0], authors: [pubkey], limit: 1 }]);
    } catch {
      view = null;
      return;
    }
    stopView = view.subscribe(changed);
    stopProfiles ??= session.profiles.subscribe(changed);
    changed();
  }
  observe();
  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Observe again after capacity or a closed view; verification restarts. */
    retry() {
      if (disposed) return;
      view?.dispose();
      observe();
    },
    dispose() {
      disposed = true;
      stopView?.();
      stopProfiles?.();
      view?.dispose();
      listeners.clear();
    },
  };
}
