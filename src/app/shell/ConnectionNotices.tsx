import { useSyncExternalStore } from "react";
import { RecoveryNotice } from "../../features/relay/RecoveryNotice";
import { useRelayConnection } from "../../features/relay/react";
import type { RelaySession } from "../../features/relay/session";
import type {
  Communities,
  Membership,
} from "../../features/communities/service";
import type { FederatedIdentity } from "../../features/federated-identity/service";
import {
  CommunityRefusalNotice,
  CommunitySignIn,
  issuerMayAnswerAgain,
} from "../../features/federated-identity/CommunitySignIn";
import { Button } from "../../shared/design-system/ui/Button";

/** The rail's connection and sign-in notices: relay outages recover through
 * one automatic owner and a community's refusal says what fixes it, each in
 * one notice on every page. */
export function ConnectionNotices({
  communities,
  federatedIdentity,
}: {
  communities: Pick<Communities, "relay" | "subscribe" | "snapshot">;
  federatedIdentity?: FederatedIdentity | undefined;
}) {
  const connection = useRelayConnection(communities.relay);
  const { memberships } = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const identity = communityIdentity(federatedIdentity, connection.origin);
  if (connection.status === "ready" || connection.cached)
    return (
      <>
        {!connection.cached && (
          <RecoveryNotice recovery={connection.session.recovery} />
        )}
        <LiveSignIn
          session={connection.session}
          identity={identity}
          relay={connection.origin}
          memberships={memberships}
          tryAgain={() => communities.relay.tryAgain()}
        />
      </>
    );
  // A connection retrying by itself is still connecting.
  return connection.status === "error" &&
    connection.denied &&
    !connection.retrying ? (
    <CommunityRefusalNotice
      // A refusal while connecting is the relay's about access.
      refusal={connection.refusal ?? "access"}
      identity={identity}
      retry={() => communities.relay.tryAgain()}
      relay={connection.origin}
      memberships={memberships}
    />
  ) : null;
}

/** The sign-in session for the community's own server, when it has one. */
function communityIdentity(
  identity: FederatedIdentity | undefined,
  origin: string | undefined,
) {
  return (origin && identity?.forCommunity?.(origin)) || identity;
}

/** A protected community can refuse after its channel list is shown: native
 * discovery hands back the transport before NIP-FI admission, so the refusal
 * arrives on the live socket. Its recovery reconnects only that socket; a
 * refusal its sign-in server may change offers Try again, which asks it. */
function LiveSignIn({
  session,
  identity,
  relay,
  memberships,
  tryAgain,
}: {
  session: RelaySession;
  identity: FederatedIdentity | undefined;
  relay: string | undefined;
  memberships: readonly Membership[];
  tryAgain: () => void;
}) {
  const live = useSyncExternalStore(
    session.live.subscribe,
    session.live.snapshot,
    session.live.snapshot,
  );
  if (live.status !== "error") return null;
  const asksAgain = !!identity && issuerMayAnswerAgain(live.error);
  return (
    <>
      <CommunitySignIn
        identity={identity}
        error={live.error}
        retry={session.live.retry}
        relay={relay}
        memberships={memberships}
        asksAgain={asksAgain}
      />
      {asksAgain && <Button onClick={tryAgain}>Try again</Button>}
    </>
  );
}
