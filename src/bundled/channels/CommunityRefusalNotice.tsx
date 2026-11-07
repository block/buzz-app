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
  return (
    <EmptyState
      icon={<LockIcon />}
      {...(prompt
        ? {
            title: prompt.expired
              ? "Sign in again to open this community"
              : "Sign in to open this community",
            description: prompt.expired
              ? `Your ${prompt.server} sign-in has expired.`
              : `This community needs your ${prompt.server} sign-in.`,
            action: identity && state && (
              <SignInButton
                identity={identity}
                state={state}
                retry={retry}
                variant="primary"
              />
            ),
          }
        : refusal === "sign-in"
          ? {
              title: "Sign in again to open this community",
              description: "Your sign-in for this community has ended.",
              action: tryAgain,
            }
          : {
              title: "You don’t have access to this community",
              description:
                "This account isn’t a member. Ask one of its admins to add you, or switch to an account that has access.",
              action: tryAgain,
            })}
    />
  );
}
