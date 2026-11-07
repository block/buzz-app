import { useSyncExternalStore } from "react";
import type { FederatedIdentity } from "../../features/federated-identity/service";
import {
  SignInButton,
  signInPrompt,
} from "../../features/federated-identity/CommunitySignIn";
import type { CommunityRefusal } from "../../features/relay/http-admission";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { Button } from "../../shared/design-system/ui/Button";
import { LockIcon } from "../../shared/design-system/icons";

const noSubscription = () => () => {};

/** The one report of a community's refusal: the sidebar beside it stays
 * quiet, and nothing behind it repeats a failed read. A missing or expired
 * sign-in its server can renew here offers that sign-in, not Try again. */
export function CommunityRefusalNotice({
  refusal,
  identity,
  retry,
}: {
  refusal?: CommunityRefusal | undefined;
  /** The sign-in session of the refusing community's own server. */
  identity?: FederatedIdentity | undefined;
  retry: () => void;
}) {
  const state = useSyncExternalStore(
    identity?.subscribe ?? noSubscription,
    () => identity?.snapshot(),
    () => identity?.snapshot(),
  );
  const prompt = refusal === "sign-in" ? signInPrompt(state) : null;
  const tryAgain = (
    <Button type="button" variant="primary" onClick={retry}>
      Try again
    </Button>
  );
  // Signed out, never signed in or expired: one prompt. Only its action
  // depends on whether this device can sign in to the community's server.
  return refusal === "sign-in" ? (
    <EmptyState
      icon={<LockIcon />}
      title="Sign in to open this community"
      description={
        prompt
          ? `This community needs your ${prompt.server} sign-in.`
          : "This community needs you to sign in."
      }
      action={
        prompt && identity && state ? (
          <SignInButton
            identity={identity}
            state={state}
            retry={retry}
            variant="primary"
          />
        ) : (
          tryAgain
        )
      }
    />
  ) : (
    <EmptyState
      icon={<LockIcon />}
      title="You don’t have access to this community"
      description="This account isn’t a member. Ask one of its admins to add you, or switch to an account that has access."
      action={tryAgain}
    />
  );
}
