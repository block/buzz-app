import { useEffect, useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import type { Session } from "./session";

// Settings layout adapted from Jarrod Sibbison's Builderlab card in #581.
export function Login({
  session,
  active,
}: {
  session: Session;
  active(): boolean;
}) {
  const state = useSyncExternalStore(
    session.subscribe,
    session.snapshot,
    session.snapshot,
  );
  useEffect(() => {
    void session.refresh();
    return () => session.cancel();
  }, [session]);
  const busy = state.status !== "idle";
  const signingIn = state.status === "signing-in";
  return (
    <div data-buzz-ui="" className="flex flex-col items-start gap-4">
      <div>
        <h2 className="text-heading text-primary">Builderlab</h2>
        <p className="mt-2 text-body-sm text-secondary">
          Sign in through your browser. Your session is saved where the bl CLI
          keeps its sessions. When both use the same profile and service,
          signing out ends the session for both.
        </p>
      </div>
      <p role="status" className="text-body-sm text-secondary">
        {signingIn
          ? "Finish sign-in in your browser, then return to Buzz."
          : state.status === "loading"
            ? "Checking your saved session…"
            : state.status === "signing-out"
              ? "Signing out…"
              : state.account
                ? `Signed in as ${state.account.email || state.account.name || "a Builderlab user"}.`
                : state.unverified
                  ? "Your saved session could not be verified."
                  : "Sign in to Builderlab."}
      </p>
      {state.account && (
        <p className="text-body-sm text-secondary">
          Profile: {state.account.profile}. Service: {state.account.serviceUrl}
        </p>
      )}
      {state.error && (
        <p role="alert" className="text-body-sm text-danger">
          {state.error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          variant={state.account ? "outline" : "prominent"}
          disabled={busy && !signingIn}
          onClick={() => {
            if (!active()) return;
            if (signingIn) session.cancel();
            else if (state.account) void session.signOut();
            else void session.signIn();
          }}
        >
          {signingIn
            ? "Cancel sign-in"
            : state.account
              ? "Sign out"
              : "Sign in with Builderlab"}
        </Button>
        {!state.account && state.unverified && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (active()) void session.signOut();
            }}
          >
            Clear saved session
          </Button>
        )}
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            if (active()) void session.refresh();
          }}
        >
          Refresh session
        </Button>
      </div>
    </div>
  );
}
