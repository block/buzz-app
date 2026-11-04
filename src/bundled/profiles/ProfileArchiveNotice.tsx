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
}: {
  session: RelaySession;
  pubkey: string;
  context: PanelProps["context"];
}) {
  const archives = session.archives;
  const snapshot = useSyncExternalStore(
    archives.subscribe,
    archives.snapshot,
    archives.snapshot,
  );
  useEffect(() => {
    void archives.ensure();
  }, [archives]);
  const archived = snapshot.archived.includes(pubkey);
  const [replacement, setReplacement] = useState<{
    of: string;
    key: string | undefined;
  }>();
  // A new archive snapshot may carry a newer delta, so it rereads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: snapshot.eventId is an explicit reread trigger.
  useEffect(() => {
    if (!archived) return;
    const controller = new AbortController();
    void archives.replacement(pubkey, controller.signal).then(
      (key) => {
        if (!controller.signal.aborted) setReplacement({ of: pubkey, key });
      },
      () => {},
    );
    return () => controller.abort();
  }, [archives, archived, pubkey, snapshot.eventId]);
  if (!archived) return null;
  const successor = replacement?.of === pubkey ? replacement.key : undefined;
  return (
    <p className="text-body-sm text-secondary" data-testid="profile-archived">
      {successor ? (
        <>
          This key was replaced by{" "}
          <SuccessorLink
            session={session}
            successor={successor}
            context={context}
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
}: {
  session: RelaySession;
  successor: string;
  context: PanelProps["context"];
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
      onClick={() => (context.push ?? context.open)(target)}
    >
      {name}
    </Button>
  ) : (
    <span>{name}</span>
  );
}
