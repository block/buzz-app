import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useIdentityNames } from "../../features/identity-names/react";
import type { PanelProps } from "../../features/panels/service";
import { profileTarget } from "../../features/profiles/target";
import { selectProfiles } from "../../features/relay/profile-selection";
import { useProfileGeneration } from "../../features/relay/react";
import type { RelaySession } from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";
import { formatPublicKey } from "../../shared/identity/public-key";

/** Says that this identity is archived in this community and, when the
 * relay's archive delta names one, links its replacement key. Presentation
 * only: archival hides a key from choosers, it is not a ban. */
export function ProfileArchiveNotice({
  session,
  pubkey,
  context,
  open,
}: {
  session: RelaySession;
  pubkey: string;
  context: PanelProps["context"];
  /** Opens the replacement's profile; defaults to the panel context. */
  open?: ((target: string) => void) | undefined;
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
  useEffect(() => {
    void readAt;
    if (!archived) return;
    const controller = new AbortController();
    void archives.replacement(pubkey, controller.signal).then(
      (key) => {
        if (!controller.signal.aborted)
          setReplacement({ of: pubkey, snapshot: eventId, key });
      },
      () => {},
    );
    return () => controller.abort();
  }, [archives, archived, pubkey, eventId, readAt]);
  if (!archived) return null;
  const successor =
    replacement?.of === pubkey && replacement.snapshot === eventId
      ? replacement.key
      : undefined;
  return (
    <p className="text-body-sm text-secondary" data-testid="profile-archived">
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
  const selection = useMemo(
    () => selectProfiles(session.profiles, [successor]),
    [session.profiles, successor],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  const profileGeneration = useProfileGeneration(session.profiles);
  useEffect(() => {
    void profileGeneration;
    void session.profiles.ensure([successor], "background").catch(() => {});
  }, [session, successor, profileGeneration]);
  const identityName = useIdentityNames(session.names);
  const name = identityName(
    successor,
    profiles.get(successor)?.name ?? formatPublicKey(successor) ?? successor,
  );
  const target = profileTarget(successor);
  return target && context?.canOpen(target) ? (
    <Button
      size="inline"
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
