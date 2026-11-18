import { useEffect, useState, useSyncExternalStore } from "react";
import { profileTarget } from "../../features/profiles/target";
import type { RelaySession } from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";
import { useProfileName } from "./useProfileName";

/** Says that this identity is archived in this community and, when the
 * relay's archive delta names one, links its replacement key. Presentation
 * only: archival hides a key from choosers, it is not a ban. */
export function ProfileArchiveNotice({
  session,
  pubkey,
  canOpen,
  open,
  hidden,
}: {
  session: RelaySession;
  pubkey: string;
  /** Whether this surface can open a profile target; when not, the
   * replacement's name shows without a link. */
  canOpen: ((target: string) => boolean) | undefined;
  /** Opens the replacement's profile target. */
  open: ((target: string) => unknown) | undefined;
  /** Hides the text but keeps it mounted, so its reads continue. */
  hidden?: boolean | undefined;
}) {
  const archives = session.archives;
  const snapshot = useSyncExternalStore(
    archives.subscribe,
    archives.snapshot,
    archives.snapshot,
  );
  // Archive reads are finite snapshots, so each opening reads the current one,
  // and so does a stale (idle) snapshot, as after a dropped connection.
  useEffect(() => {
    void pubkey;
    void archives.refresh();
  }, [archives, pubkey]);
  const idle = snapshot.status === "idle";
  useEffect(() => {
    if (idle) void archives.ensure();
  }, [archives, idle]);
  const archived = snapshot.archived.includes(pubkey);
  // A result counts only for the snapshot it was read under, so a corrected
  // archive never keeps an earlier replacement, even when the reread fails.
  const [replacement, setReplacement] = useState<{
    of: string;
    snapshot: string | undefined;
    key: string | undefined;
  }>();
  const eventId = snapshot.eventId;
  // Each snapshot read, also one that keeps its event, retries a lookup that
  // an interruption or a failure left unanswered.
  const readAt = snapshot.readAt;
  // A reread in progress answers again when it lands, so a lookup now would
  // be read twice. The live status counts: the opening's refresh, in the same
  // commit, has already started one.
  const loading = snapshot.status === "loading";
  useEffect(() => {
    void readAt;
    void loading;
    if (!archived || archives.snapshot().status === "loading") return;
    const controller = new AbortController();
    void archives.replacement(pubkey, controller.signal).then(
      (key) => {
        if (!controller.signal.aborted)
          setReplacement({ of: pubkey, snapshot: eventId, key });
      },
      () => {},
    );
    return () => controller.abort();
  }, [archives, archived, loading, pubkey, eventId, readAt]);
  if (!archived) return null;
  const successor =
    replacement?.of === pubkey && replacement.snapshot === eventId
      ? replacement.key
      : undefined;
  return (
    <p
      className="text-body-sm text-secondary"
      data-testid="profile-archived"
      hidden={hidden}
    >
      {successor ? (
        <>
          This key was replaced by{" "}
          <SuccessorLink
            session={session}
            successor={successor}
            canOpen={canOpen}
            open={open}
          />
          .
        </>
      ) : (
        "This key is archived in this community."
      )}
    </p>
  );
}

function SuccessorLink({
  session,
  successor,
  canOpen,
  open,
}: {
  session: RelaySession;
  successor: string;
  canOpen: ((target: string) => boolean) | undefined;
  open: ((target: string) => unknown) | undefined;
}) {
  const name = useProfileName(session, successor);
  const target = profileTarget(successor);
  return target && open && canOpen?.(target) ? (
    <Button
      size="text"
      variant="link"
      aria-label={`Open new key profile: ${name}`}
      onClick={() => void open(target)}
    >
      {name}
    </Button>
  ) : (
    <span>{name}</span>
  );
}
