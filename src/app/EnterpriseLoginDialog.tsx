import { useEffect, useSyncExternalStore } from "react";
import { AlertDialog } from "../shared/design-system/ui/AlertDialog";
import { Button } from "../shared/design-system/ui/Button";
import { useToastNotification } from "../shared/design-system/ui/Toast";
import type {
  Communities,
  EnterpriseLoginSnapshot,
} from "../features/communities/service";

export function EnterpriseLoginDialog({
  communities,
  state,
}: {
  communities: Communities;
  state: EnterpriseLoginSnapshot;
}) {
  return (
    <AlertDialog
      title="Sign in to this community"
      description="This trusted community requires enterprise sign-in before Buzz can connect."
      onClose={() => communities.dismissEnterpriseLogin(state.communityId)}
      actions={
        <>
          <Button
            type="button"
            onClick={
              state.status === "opening"
                ? () => communities.cancelEnterpriseLogin(state.communityId)
                : () => communities.dismissEnterpriseLogin(state.communityId)
            }
          >
            {state.status === "opening" ? "Cancel" : "Not now"}
          </Button>
          {state.status !== "opening" && (
            <Button
              type="button"
              variant="prominent"
              disabled={state.waiting}
              onClick={() =>
                void (state.errorKind === "discovery"
                  ? communities.retryEnterpriseGate(state.communityId)
                  : communities.startEnterpriseLogin(state.communityId))
              }
            >
              {state.errorKind === "discovery"
                ? "Retry connection check"
                : state.status === "error"
                  ? "Retry sign-in"
                  : "Sign in"}
            </Button>
          )}
        </>
      }
    >
      {state.status === "opening" ? (
        <p role="status">A browser window is open for sign-in.</p>
      ) : state.error ? (
        <p role="alert">{state.error}</p>
      ) : state.waiting ? (
        <p role="status">Finishing sign-out before you can sign in again.</p>
      ) : (
        <p>Buzz will return here after the browser sign-in is complete.</p>
      )}
      {state.cleanup && <p role="alert">{cleanupMessage(state.cleanup)}</p>}
    </AlertDialog>
  );
}

function cleanupMessage({
  retained,
  unrecorded,
  unpruned,
}: NonNullable<EnterpriseLoginSnapshot["cleanup"]>) {
  return [
    retained && unrecorded
      ? "Buzz couldn't remove your previous sign-in from secure storage or record that it was refused. Requests already under way may finish, but Buzz starts no new ones with it while it stays open. It may send it again after a restart."
      : retained
        ? "Buzz couldn't remove your previous sign-in from secure storage. Requests already under way may finish, but Buzz starts no new ones with it and will retry removing it."
        : unrecorded
          ? "Buzz couldn't record that your previous sign-in was refused."
          : undefined,
    unpruned ? UNPRUNED : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

const UNPRUNED =
  "Buzz couldn't remove an outdated sign-in record from this device.";

/** Notes once, after a successful login, that an outdated sign-in record
 * couldn't be removed. */
export function EnterpriseCleanupNotice({
  communities,
}: {
  communities: Communities;
}) {
  const notify = useToastNotification();
  const notice = useSyncExternalStore(
    communities.subscribe,
    () => communities.snapshot().enterpriseNotice,
  );
  useEffect(() => {
    // Consumed before it is shown, so a replayed effect (StrictMode) sees
    // it gone and does not show it again.
    if (!notice || !communities.snapshot().enterpriseNotice) return;
    communities.dismissEnterpriseNotice();
    notify(UNPRUNED, "info");
  }, [notice, notify, communities]);
  return null;
}
