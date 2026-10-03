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
      ) : (
        <p>Buzz will return here after the browser sign-in is complete.</p>
      )}
    </AlertDialog>
  );
}
