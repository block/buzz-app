import { Button } from "../../shared/design-system/ui/Button";
import type { FoundCommunity } from "../communities/find-community";
import { FoundCommunityRow } from "../communities/FoundCommunityRow";

/**
 * Where an invite or community link opened from outside Buzz lands on a
 * device with no identity, once the lookup found a community this build's
 * Builderlab hosts. It names the community and offers the landing's two
 * account actions, in the landing's order; the sign-in they start is the
 * person's choice here, and the waiting page's Cancel returns here.
 * Nothing is claimed or joined: setup ends on Join Community for the address.
 */
export function Invited({
  found,
  coded,
  returning,
  restoring,
  onStart,
  onDecline,
}: {
  found: Pick<FoundCommunity, "host" | "name" | "icon">;
  /** The link carries an invite code; a community link has none. */
  coded: boolean;
  /** This device signed in before, so Sign in leads, as on the landing. */
  returning: boolean;
  /** The saved session is still being restored: neither action can start. */
  restoring: boolean;
  /** Starts sign-in, on the account page's sign-up form for `create`. */
  onStart: (create: boolean) => void;
  /** Drops the link and returns to the landing. */
  onDecline: () => void;
}) {
  return (
    <>
      <div>
        <h1
          id="welcome-title"
          tabIndex={-1}
          className="text-heading text-standard"
        >
          {coded ? "You’re invited" : "Join this community"}
        </h1>
        <p className="mt-2 text-body text-subtle">
          You need an account to join. Your browser will open so you can create
          one or sign in, then you’ll come back to Buzz to join.
        </p>
      </div>
      <FoundCommunityRow found={found} address={found.host} />
      <div className="flex flex-col gap-2">
        <Button
          variant="prominent"
          size="lg"
          disabled={restoring}
          data-return-focus={returning ? "sign-in" : "sign-up"}
          onClick={() => onStart(!returning)}
        >
          {returning ? "Sign in" : "Create account"}
        </Button>
        <Button
          size="lg"
          disabled={restoring}
          data-return-focus={returning ? "sign-up" : "sign-in"}
          onClick={() => onStart(returning)}
        >
          {returning ? "Create account" : "Sign in"}
        </Button>
        <Button size="lg" variant="ghost" onClick={onDecline}>
          Not now
        </Button>
      </div>
    </>
  );
}
