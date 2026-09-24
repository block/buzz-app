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
const failedView = (): EventViewSnapshot => failedSnapshot;
const pendingSnapshot: EventViewSnapshot = Object.freeze({
  status: "loading",
  events: [],
});
const failedSnapshot: EventViewSnapshot = Object.freeze({
  status: "error",
  events: [],
  error: "Relay view unavailable",
});

/** Public agent provenance from verifiable relay evidence only. Mounted for an
 * agent hint, which decides visibility but never who owns the key. */
export function ProfileAgentIdentity({
  session,
  pubkey,
  context,
}: {
  session: RelaySession;
  pubkey: string;
  context: PanelProps["context"];
}) {
  // A session-owned view: live events, reconnect refresh and purge, no polling.
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<ProfileView | null>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is explicit recovery.
  useEffect(() => {
    let owned: ProfileView;
    try {
      owned = session.observe([{ kinds: [0], authors: [pubkey], limit: 1 }]);
    } catch {
      setView(null); // Capacity or a closed session: honestly unknown, retryable.
      return;
    }
    setView(owned);
    return owned.dispose;
  }, [session, pubkey, attempt]);
  const fallback = view === null ? failedView : pendingView;
  const events = useSyncExternalStore(
    view?.subscribe ?? noSubscribe,
    view?.snapshot ?? fallback,
    view?.snapshot ?? fallback,
  );
  // Provenance belongs to the winning signed kind 0 alone, never a display projection.
  // The directory's retained head outlives this view, so a reopened pane cannot
  // accept an older response than the profile the rest of the session shows.
  // Subscribed, so any head change (live, read or disk restore) re-renders.
  // Without a live view, stay Unknown.
  const directoryHead = useSyncExternalStore(
    session.profiles.subscribe,
    () => session.profiles.event?.(pubkey),
    () => session.profiles.event?.(pubkey),
  );
  const head = view ? directoryHead : undefined;
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
  const archives = session.archives;
  const archiveSnapshot = useSyncExternalStore(
    archives.subscribe,
    archives.snapshot,
    archives.snapshot,
  );
  const archive = archives.state(pubkey);
  // Fetch from idle (first mount, purge, reconnect invalidation). A prior error is
  // retried once per mount (reopening the profile) or by Retry, never in a loop.
  useEffect(() => {
    if (archives.snapshot().status === "error") void archives.refresh();
  }, [archives]);
  useEffect(() => {
    if (events.status === "idle") void view?.refresh();
  }, [view, events.status]);
  useEffect(() => {
    if (archiveSnapshot.status === "idle") void archives.ensure();
  }, [archives, archiveSnapshot.status]);
  const current = verified && latest && verified.id === latest.id;
  const owner = current ? verified.owner : undefined;
  const failed =
    (!latest && events.status === "error") ||
    archiveSnapshot.status === "error";
  return (
    <section aria-label="Agent identity" className={styles.agentIdentity}>
      <h3 className="text-body">Agent</h3>
      <dl>
        <dt>Owner</dt>
        <dd>
          {owner ? (
            <OwnerLink session={session} owner={owner} context={context} />
          ) : current || (!latest && events.status === "ready") ? (
            "Not verified — no valid owner attestation."
          ) : !latest && events.status === "error" ? (
            "Unknown — could not read this profile's attestation."
          ) : (
            "Checking…"
          )}
        </dd>
        <dt>Archive</dt>
        <dd>
          {archive === "archived"
            ? "Archived on this relay"
            : archive === "not-archived"
              ? "Not archived"
              : "Unknown"}
        </dd>
      </dl>
      {failed && (
        <Button
          size="compact"
          onClick={() => {
            if (!latest && events.status === "error")
              view ? void view.refresh() : setAttempt((value) => value + 1);
            if (archiveSnapshot.status === "error") void archives.refresh();
          }}
        >
          Retry agent details
        </Button>
      )}
    </section>
  );
}

function OwnerLink({
  session,
  owner,
  context,
}: {
  session: RelaySession;
  owner: string;
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
  const name = identityName(
    owner,
    profiles.get(owner)?.name ?? formatPublicKey(owner) ?? owner,
  );
  const target = profileTarget(owner);
  return (
    <>
      Authorized by{" "}
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
    </>
  );
}
