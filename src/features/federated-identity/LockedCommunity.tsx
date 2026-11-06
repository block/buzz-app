import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LockIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { CommunitySignIn, recoveryMessage } from "./CommunitySignIn";
import { LOCKED_SIGN_IN } from "./lock";
import type { Membership } from "../communities/service";
import type { FederatedIdentity } from "./service";

/** Hides saved history until admission. Expiry can prompt once; explicit
 * sign-out and cancellation always leave the next sign-in to the person. */
export function LockedCommunity({
  identity,
  retry,
  relay,
  memberships,
}: {
  identity: FederatedIdentity;
  retry?: () => void;
  relay?: string | undefined;
  memberships?: readonly Membership[];
}) {
  const state = useSyncExternalStore(
    identity.subscribe,
    identity.snapshot,
    identity.snapshot,
  );
  const [failure, setFailure] = useState("");
  const run = (operation: () => Promise<unknown>) => {
    setFailure("");
    void operation().catch((error: unknown) =>
      setFailure(error instanceof Error ? error.message : "sign-in-failed"),
    );
  };
  const started = useRef(false);
  useEffect(() => {
    if (state.status === "signed-in") started.current = true;
    if (
      LOCKED_SIGN_IN !== "reauthentication" ||
      started.current ||
      state.status !== "reauthentication-required"
    )
      return;
    started.current = true;
    void identity.signIn().catch(() => {});
  }, [identity, state.status]);

  const organization = state.authority?.organization;
  const signingIn = state.status === "signing-in";
  const checking = state.status === "restoring";
  const offline =
    state.status === "unavailable" &&
    (state.failure === "network-unavailable" ||
      state.failure === "network-timeout");
  const unavailable = state.status === "unavailable";
  const signedIn = state.status === "signed-in";
  const description = checking
    ? "Checking your sign-in…"
    : signedIn
      ? "Your community’s saved conversations stay hidden until Buzz confirms your access."
      : signingIn
        ? "Finish signing in in your browser. This community opens as soon as you’re done."
        : offline
          ? "Your sign-in has ended. Connect to the internet to sign in again."
          : unavailable
            ? recoveryMessage(state.failure ?? "")
            : `Your ${organization ? `${organization} ` : ""}sign-in has ended. Sign in again to see this community.`;
  return (
    <section aria-label="Sign in to continue" className="page-status">
      <EmptyState
        icon={<LockIcon />}
        title="Sign in to continue"
        description={
          <>
            {description}
            {failure && (
              <span role="alert" className="block text-danger">
                {recoveryMessage(failure)}
              </span>
            )}
          </>
        }
        action={
          <>
            <CommunitySignIn
              identity={identity}
              error={state.failure ?? undefined}
              retry={retry ?? (() => {})}
              relay={relay}
              memberships={memberships}
            />
            {signingIn ? (
              <Button onClick={() => run(() => identity.cancelSignIn())}>
                Cancel
              </Button>
            ) : signedIn && retry ? (
              <>
                <Button variant="prominent" onClick={retry}>
                  Try again
                </Button>
                <Button onClick={() => run(() => identity.signIn())}>
                  Sign in again
                </Button>
              </>
            ) : (
              <Button
                variant="prominent"
                loading={checking}
                onClick={() => run(() => identity.signIn())}
              >
                {unavailable || checking
                  ? "Try again"
                  : organization
                    ? `Sign in with ${organization}`
                    : "Sign in"}
              </Button>
            )}
          </>
        }
      />
    </section>
  );
}
