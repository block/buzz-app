import { AlertDialog } from "../shared/design-system/ui/AlertDialog";
import { Button } from "../shared/design-system/ui/Button";
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
}: NonNullable<EnterpriseLoginSnapshot["cleanup"]>) {
  if (retained && unrecorded)
    return "Buzz couldn't remove your previous sign-in from secure storage or record that it was refused. It won't be used again while Buzz is open, but it may be sent again after Buzz restarts.";
  if (retained)
    return "Buzz couldn't remove your previous sign-in from secure storage. It won't be used again, and Buzz will retry removing it.";
  return "Buzz couldn't record that your previous sign-in was refused.";
}
