import { useEffect, useSyncExternalStore } from "react";
import { Header } from "../../../shared/design-system/ui/Header";
import { Button } from "../../../shared/design-system/ui/Button";
import styles from "../Settings.module.css";
import type { OAuthSession } from "../oauth/session";

export function Login({
  session,
  available,
  active,
  showHeading = true,
  cancelOnUnmount = true,
  unavailableReason = "Open the Buzz desktop app to sign in with Builderlab.",
}: {
  session: OAuthSession;
  available: boolean;
  active(): boolean;
  showHeading?: boolean;
  /** Settings owns its pending login; shared app panels only observe it. */
  cancelOnUnmount?: boolean;
  unavailableReason?: string;
}) {
  const state = useSyncExternalStore(
    session.subscribe,
    session.snapshot,
    session.snapshot,
  );
  useEffect(
    () => () => {
      if (cancelOnUnmount && session.snapshot().status === "pending")
        session.cancel();
    },
    [cancelOnUnmount, session],
  );
  return (
    <div data-buzz-ui="" className="grid gap-3">
      {showHeading ? (
        <Header
          title="Builderlab"
          subtitle="Connect your Builderlab account. Your credential stays in memory until you sign out or close Buzz."
        />
      ) : null}
      {!available ? (
        <p role="status" className="text-body-sm text-secondary">
          {unavailableReason}
        </p>
      ) : (
        <>
          <dl className={styles.accountRow}>
            <dt className="text-body-sm text-secondary">Connection</dt>
            <dd className={styles.accountValue}>
              <p role="status" className="m-0 text-body-sm">
                {state.status === "pending"
                  ? "Finish sign-in in your browser, then return to Buzz."
                  : state.account
                    ? state.account.email
                      ? state.account.email
                      : "Signed in to Builderlab."
                    : "Sign in securely in your browser."}
              </p>
              <Button
                variant={state.status === "signed-out" ? "prominent" : "subtle"}
                size="sm"
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
                    : "Sign in with Builderlab"}
              </Button>
            </dd>
          </dl>
          {state.error && (
            <p role="alert" className="m-0 text-body-sm text-danger">
              {state.error}
            </p>
          )}
          <p className="m-0 text-caption text-secondary">
            Your sign-in lasts until you sign out or close Buzz.
          </p>
        </>
      )}
    </div>
  );
}
