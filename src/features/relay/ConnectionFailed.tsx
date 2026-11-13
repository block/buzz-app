import { communityRefusalTitle } from "../federated-identity/CommunitySignIn";
import { CloudOffIcon, LockIcon } from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import type { Navigation } from "../navigation/controller";
import type { RelayData, RelaySnapshot } from "./service";

/** The community answered in a way this Buzz can't use. Its only action is
 * Check for updates, so the sentence neither asks to try again nor promises
 * an update fixes it; everywhere the failure shows, it says this. */
export const UNUSABLE_CONNECTION = "Buzz couldn’t connect to this community.";

/** One sentence for a failed connection, for the pages that say it in their
 * own status line rather than with the card. */
export function connectionFailureText(
  connection: Pick<RelaySnapshot, "denied" | "refusal" | "retrying" | "error">,
) {
  if (connection.denied) return communityRefusalTitle(connection.refusal);
  if (connection.error?.kind === "unusable") return UNUSABLE_CONNECTION;
  return connection.retrying
    ? "Check your connection. We’ll keep trying."
    : "Check your connection, then try again.";
}

/** Opens Settings → Software updates, for `openUpdates`. */
export const openUpdatesWith = (navigator: Pick<Navigation, "open">) => () =>
  void navigator.open({ version: 1, kind: "settings", section: "updates" });

/** The action beside `connectionFailureText` on those pages, as the card
 * offers it: Retry connection, or for an answer this Buzz can't use, Check
 * for updates (nothing without `openUpdates`). Nothing for a refusal, whose
 * own notice offers what fixes it, or a connection that hasn't failed. */
export function connectionFailureAction({
  connection,
  relay,
  openUpdates,
  size,
}: {
  connection: Pick<RelaySnapshot, "status" | "denied" | "error">;
  relay: Pick<RelayData, "tryAgain">;
  openUpdates?: (() => void) | undefined;
  size?: "sm";
}) {
  if (connection.status !== "error" || connection.denied) return undefined;
  const sized = size ? { size } : {};
  if (connection.error?.kind === "unusable")
    return openUpdates ? (
      <Button type="button" {...sized} onClick={openUpdates}>
        Check for updates
      </Button>
    ) : undefined;
  return (
    <Button type="button" {...sized} onClick={() => relay.tryAgain()}>
      Retry connection
    </Button>
  );
}

/** What a page shows in place of its content while the community session is in
 * `error`: the refusal notice when the community refused this account, with no
 * Try again; otherwise the plain "Can’t connect" card, which for an answer
 * this Buzz can't use says only that and offers Check for updates in place of
 * Try again. `className` frames it within the page. */
export function ConnectionFailed({
  connection,
  relay,
  className,
  openUpdates,
}: {
  connection: Pick<RelaySnapshot, "denied" | "refusal" | "retrying" | "error">;
  relay: Pick<RelayData, "tryAgain">;
  className?: string | undefined;
  /** Opens Settings → Software updates, for a failure an update may fix. */
  openUpdates?: (() => void) | undefined;
}) {
  if (connection.denied)
    // The community refused this account. Its notice, on every page, says what
    // fixes it and offers that; this only says why it's empty.
    return (
      <div className={className}>
        <EmptyState
          icon={<LockIcon />}
          title={communityRefusalTitle(connection.refusal)}
        />
      </div>
    );
  const unusable = connection.error?.kind === "unusable";
  return (
    <div role="alert" className={className}>
      <EmptyState
        icon={<CloudOffIcon />}
        title="Can’t connect"
        description={
          unusable
            ? UNUSABLE_CONNECTION
            : connection.retrying
              ? "Check your connection. We’ll keep trying."
              : "Check your connection, then try again."
        }
        action={
          unusable ? (
            openUpdates && (
              <Button type="button" variant="primary" onClick={openUpdates}>
                Check for updates
              </Button>
            )
          ) : (
            <Button
              type="button"
              variant="primary"
              onClick={() => relay.tryAgain()}
            >
              Try again
            </Button>
          )
        }
      />
    </div>
  );
}
