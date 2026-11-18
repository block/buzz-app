import { useEffect, useState, useSyncExternalStore } from "react";
import type { PanelProps } from "../../features/panels/service";
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
  context,
  open,
  hidden,
}: {
  session: RelaySession;
  pubkey: string;
  context: PanelProps["context"];
  /** Opens the replacement's profile; defaults to the panel context. */
  open?: ((target: string) => void) | undefined;
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
  // be read twice.
  const loading = snapshot.status === "loading";
  useEffect(() => {
    void readAt;
    if (!archived || loading) return;
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
            context={context}
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
  context,
  open,
}: {
  session: RelaySession;
  successor: string;
  context: PanelProps["context"];
  open: ((target: string) => void) | undefined;
}) {
  const name = useProfileName(session, successor);
  const target = profileTarget(successor);
  return target && context?.canOpen(target) ? (
    <Button
      size="text"
      variant="link"
      aria-label={`Open new key profile: ${name}`}
      onClick={() => (open ?? context.push ?? context.open)(target)}
    >
      {name}
    </Button>
  ) : (
    <span>{name}</span>
  );
}
