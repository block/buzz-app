import { Button } from "../../shared/design-system/ui/Button";
import type { FoundCommunity } from "../communities/find-community";
import { FoundCommunityRow } from "../communities/FoundCommunityRow";
import { OnboardingBack } from "./OnboardingBack";

/**
 * First run while its sign-in is in the browser: one page in two states.
 * Waiting, Buzz carries on by itself once the browser finishes, so the
 * primary action is there and neither action here is prominent. Timed out,
 * Buzz stopped waiting, though the person may still be signing up or
 * verifying their email there: not a failure, and Continue picks it up.
 * The page changes state in place, so its line is a polite status: the
 * change is announced without moving focus, and never as an alert. Either
 * way a community first run joins afterwards is named as the next step, so
 * signing in and joining read as two.
 */
export function BrowserSignIn({
  timedOut,
  community,
  onOpen,
  onLeave,
}: {
  /** Buzz stopped waiting on the browser. */
  timedOut: boolean;
  /** The community joined after sign-in, as far as first run knows it. */
  community?: Pick<FoundCommunity, "host" | "name" | "icon"> | undefined;
  /** Opens the browser on the sign-in again. */
  onOpen: () => void;
  /** Cancel while waiting, Back once timed out: the page that started it. */
  onLeave: () => void;
}) {
  return (
    <>
      <div>
        <h1
          id="welcome-title"
          tabIndex={-1}
          className="text-heading text-standard"
        >
          {timedOut ? "Finish in your browser" : "Continue in your browser"}
        </h1>
        <p role="status" className="mt-2 text-body text-subtle">
          {timedOut
            ? "Buzz stopped waiting. Finish signing in there, then come back and choose Continue."
            : "Create your account or sign in there. Buzz is waiting, and carries on here when you’re done."}
        </p>
      </div>
      {community && (
        <div className="flex flex-col gap-2">
          <p className="m-0 text-body text-subtle">
            Next, you’ll join this community.
          </p>
          <FoundCommunityRow found={community} address={community.host} />
        </div>
      )}
      {/* Footer order: secondary first, primary last. */}
      <div data-onboarding-actions="">
        <OnboardingBack
          aria-label={timedOut ? "Back" : "Cancel"}
          onClick={onLeave}
        />
        <Button
          variant={timedOut ? "prominent" : "subtle"}
          size="lg"
          onClick={onOpen}
        >
          {timedOut ? "Continue" : "Open browser"}
        </Button>
      </div>
    </>
  );
}
