import { useEffect, useState } from "react";
import type { MemorySnapshot } from "../../features/agents/memory";
import type { RelaySession } from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./Profiles.module.css";

/** Presentation only: the session owns access, plaintext and pending requests. */
export function ProfileMemories({
  session,
  pubkey,
}: {
  session: RelaySession;
  pubkey: string;
}) {
  const [current, setCurrent] = useState<{
    session: RelaySession;
    pubkey: string;
    snapshot: MemorySnapshot;
    refresh(): void;
  }>();
  useEffect(() => {
    let active = true;
    let view: ReturnType<RelaySession["agentMemories"]["open"]>;
    try {
      view = session.agentMemories.open(pubkey);
    } catch {
      setCurrent({
        session,
        pubkey,
        snapshot: { status: "unavailable" },
        refresh() {},
      });
      return;
    }
    const refresh = () => {
      if (active) void view.refresh();
    };
    const update = () => {
      if (active)
        setCurrent({ session, pubkey, snapshot: view.snapshot(), refresh });
    };
    const unsubscribe = view.subscribe(update);
    update();
    refresh();
    return () => {
      active = false;
      unsubscribe();
      view.dispose();
    };
  }, [session, pubkey]);
  const state =
    current?.session === session && current.pubkey === pubkey
      ? current
      : undefined;
  const snapshot = state?.snapshot;
  const loading = !snapshot || snapshot.status === "loading";
  return (
    <section
      aria-label="Agent memories"
      className="flex min-w-0 flex-col gap-3"
    >
      <p className="m-0 text-body-sm text-secondary">
        Memories shared with your account in this community. This is a snapshot,
        not a complete history.
      </p>
      {loading ? (
        <p role="status">Loading memories…</p>
      ) : snapshot.status === "unavailable" ? (
        <p>
          Memory reads are unavailable for this profile or connection. The
          development relay broker supports owner-view reads for other
          identities.
        </p>
      ) : snapshot.status === "denied" ? (
        <p role="alert">You don’t have access to these memories.</p>
      ) : snapshot.status === "blocked" ? (
        <p role="status">
          Memory reads are paused while live updates are disconnected or session
          data is being cleared. Retry after live updates reconnect or clearing
          finishes.
        </p>
      ) : snapshot.status === "error" ? (
        <p role="alert">
          Couldn’t load memories. Check your connection and try again.
        </p>
      ) : snapshot.status === "idle" ? (
        <p>Memory data was cleared. Refresh to request a new snapshot.</p>
      ) : (
        <>
          {snapshot.listing?.partial && (
            <p role="status">
              This snapshot may be incomplete. Some records were invalid or the
              read limit was reached.
            </p>
          )}
          {!snapshot.listing?.entries.length && (
            <p>
              {snapshot.listing?.partial
                ? "No readable entries in this partial snapshot."
                : "No memories were returned for your account in this community."}
            </p>
          )}
          {snapshot.listing?.entries.map((entry) => (
            <details key={entry.slug} className={styles.memoryEntry}>
              <summary className="font-mono text-mono">
                {entry.slug === "core" ? "Core memory" : entry.slug}
              </summary>
              <p className="text-body-sm text-secondary">
                Updated {new Date(entry.createdAt * 1000).toLocaleString()}
              </p>
              <pre className={`${styles.memoryBody} font-mono text-mono`}>
                {entry.body}
              </pre>
            </details>
          ))}
        </>
      )}
      {snapshot?.status !== "unavailable" && (
        <Button
          size="compact"
          disabled={loading}
          onClick={() => state?.refresh()}
        >
          {snapshot?.status === "error" ||
          snapshot?.status === "denied" ||
          snapshot?.status === "blocked"
            ? "Retry memories"
            : "Refresh memories"}
        </Button>
      )}
    </section>
  );
}
