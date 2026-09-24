import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { attestedOwner } from "../../features/agents/owner-attestation";
import { useIdentityNames } from "../../features/identity-names/react";
import type { PanelProps } from "../../features/panels/service";
import { profileTarget } from "../../features/profiles/target";
import { type EventData, newer } from "../../features/relay/events";
import { selectProfiles } from "../../features/relay/profile-selection";
import type {
  EventViewSnapshot,
  RelaySession,
} from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";
import { formatPublicKey } from "../../shared/identity/public-key";
import styles from "./Profiles.module.css";

type ProfileView = ReturnType<RelaySession["observe"]>;
const noSubscribe = () => () => {};
const pendingView = (): EventViewSnapshot => pendingSnapshot;
const pendingSnapshot: EventViewSnapshot = Object.freeze({
  status: "loading",
  events: [],
});

/** Verified NIP-OA owner of the winning signed kind 0, or none. Agent hints
 * decide whether to mount this view; they never establish ownership. */
export function useVerifiedAgentOwner(
  session: RelaySession,
  pubkey: string | undefined,
): string | undefined {
  return useAgentOwnerEvidence(session, pubkey).owner;
}

/** Private admission must inspect readiness as well as signed-head ownership.
 * Public identity attribution may still display its retained signed evidence. */
export function useAgentOwnerEvidence(
  session: RelaySession,
  pubkey: string | undefined,
): {
  status: "loading" | "ready" | "error" | "unavailable";
  owner: string | undefined;
} {
  // A session-owned view: live events, reconnect refresh and purge, no polling.
  // Capacity or a closed session leaves no view; reopening the profile retries.
  const [view, setView] = useState<ProfileView | null>();
  useEffect(() => {
    if (!pubkey) {
      setView(null);
      return;
    }
    let owned: ProfileView;
    try {
      owned = session.observe([{ kinds: [0], authors: [pubkey], limit: 1 }]);
    } catch {
      setView(null);
      return;
    }
    setView(owned);
    return owned.dispose;
  }, [session, pubkey]);
  const events = useSyncExternalStore(
    view?.subscribe ?? noSubscribe,
    view?.snapshot ?? pendingView,
    view?.snapshot ?? pendingView,
  );
  // Provenance belongs to the winning signed kind 0 alone, never a display projection.
  // The directory's retained head outlives this view, so a reopened pane cannot
  // accept an older response than the profile the rest of the session shows.
  // Subscribed, so any head change (live, read or disk restore) re-renders.
  // Without a live view nothing can signal an auth-only change, so show nothing.
  const directoryHead = useSyncExternalStore(
    session.profiles.subscribe,
    () => (pubkey ? session.profiles.event?.(pubkey) : undefined),
    () => (pubkey ? session.profiles.event?.(pubkey) : undefined),
  );
  const head = view && pubkey ? directoryHead : undefined;
  const latest = events.events
    .filter(
      (event) =>
        event.kind === 0 &&
        event.pubkey === pubkey &&
        event.delivery !== "failed",
    )
    .reduce<EventData | undefined>(newer, head);
  const [verified, setVerified] = useState<{ id: string; owner?: string }>();
  useEffect(() => {
    if (!latest) return;
    let active = true;
    void attestedOwner(latest).then((owner) => {
      if (active) setVerified({ id: latest.id, ...(owner ? { owner } : {}) });
    });
    return () => {
      active = false;
    };
  }, [latest]);
  useEffect(() => {
    if (events.status === "idle") void view?.refresh();
  }, [view, events.status]);
  const owner =
    verified && latest && verified.id === latest.id
      ? verified.owner
      : undefined;
  // Only an already admitted result from this observation may survive a
  // background read. New heads, purges and failed reads must establish it anew.
  const [admitted, setAdmitted] = useState<{
    view: ProfileView;
    id: string;
  }>();
  useEffect(() => {
    setAdmitted((previous) => {
      if (
        events.status === "ready" &&
        view &&
        latest &&
        latest.id === verified?.id
      ) {
        return previous?.view === view && previous.id === latest.id
          ? previous
          : { view, id: latest.id };
      }
      return events.status === "loading" &&
        previous?.view === view &&
        previous?.id === latest?.id
        ? previous
        : undefined;
    });
  }, [events.status, view, latest, verified]);
  const refreshingAdmittedHead =
    !!admitted &&
    events.status === "loading" &&
    admitted?.view === view &&
    admitted?.id === latest?.id;
  const status =
    view === null
      ? "unavailable"
      : events.status === "error"
        ? "error"
        : !view ||
            (events.status !== "ready" && !refreshingAdmittedHead) ||
            (latest && verified?.id !== latest.id)
          ? "loading"
          : "ready";
  return { status, owner };
}

export function ProfileAgentIdentity({
  session,
  owner,
  viewer,
  context,
}: {
  session: RelaySession;
  owner: string;
  viewer: string | undefined;
  context: PanelProps["context"];
}) {
  return (
    <section aria-label="Agent identity" className={styles.agentIdentity}>
      <h3 className="text-body">Managed by</h3>
      <OwnerLink
        session={session}
        owner={owner}
        self={owner === viewer}
        context={context}
      />
    </section>
  );
}

function OwnerLink({
  session,
  owner,
  self,
  context,
}: {
  session: RelaySession;
  owner: string;
  self: boolean;
  context: PanelProps["context"];
}) {
  const selection = useMemo(
    () => selectProfiles(session.profiles, [owner]),
    [session.profiles, owner],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  useEffect(() => {
    void session.profiles.ensure([owner], "background").catch(() => {});
  }, [session, owner]);
  const identityName = useIdentityNames(session.names);
  const shown = identityName(
    owner,
    profiles.get(owner)?.name ?? formatPublicKey(owner) ?? owner,
  );
  const name = self ? `${shown} (you)` : shown;
  const target = profileTarget(owner);
  return (
    <div>
      {target && context?.canOpen(target) ? (
        <Button
          size="compact"
          variant="ghost"
          aria-label={`Open owner profile: ${name}`}
          onClick={() => context.open(target)}
        >
          {name}
        </Button>
      ) : (
        name
      )}
    </div>
  );
}
