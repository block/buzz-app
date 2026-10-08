import { useEffect, useSyncExternalStore } from "react";
import { Button } from "../design-system/ui/Button";
import type { OAuthSession } from "./session";

export function Login({
  provider,
  description,
  session,
  available,
  active,
  unavailableReason = `Open the Buzz desktop app to sign in with ${provider}.`,
}: {
  provider: string;
  description: string;
  session: OAuthSession;
  available: boolean;
  active(): boolean;
  unavailableReason?: string;
}) {
  const state = useSyncExternalStore(
    session.subscribe,
    session.snapshot,
    session.snapshot,
  );
  useEffect(
    () => () => {
      if (session.snapshot().status === "pending") session.cancel();
    },
    [session],
  );
  return (
    <div data-buzz-ui="" className="flex flex-col items-start gap-4">
      <div>
        <h2 className="text-heading text-primary">{provider}</h2>
        <p className="mt-2 text-body-sm text-secondary">{description}</p>
      </div>
      {!available ? (
        <p role="status" className="text-body-sm text-secondary">
          {unavailableReason}
        </p>
      ) : (
        <>
          <p role="status" className="text-body-sm text-secondary">
            {state.status === "pending"
              ? "Finish sign-in in your browser, then return to Buzz."
              : state.account
                ? state.account.email
                  ? `Signed in as ${state.account.email}.`
                  : `Signed in to ${provider}.`
                : "Sign in securely in your browser."}
          </p>
          {state.error && (
            <p role="alert" className="text-body-sm text-danger">
              {state.error}
            </p>
          )}
          <Button
            variant={state.status === "signed-out" ? "prominent" : "outline"}
            onClick={() => {
              if (!active()) return;
              if (state.status === "pending") session.cancel();
              else if (state.status === "signed-in") session.signOut();
              else void session.signIn();
            }}
          >
            {state.status === "pending"
              ? "Cancel sign-in"
              : state.status === "signed-in"
                ? "Sign out"
                : `Sign in with ${provider}`}
          </Button>
        </>
      )}
    </div>
  );
}
