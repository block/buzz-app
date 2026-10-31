import { useEffect, useRef, useSyncExternalStore } from "react";
import { Header } from "../../../shared/design-system/ui/Header";
import { Button } from "../../../shared/design-system/ui/Button";
import styles from "../Settings.module.css";
import { nativeBuilderlab, type BuilderlabSession } from "../session";

const kept = () =>
  nativeBuilderlab()
    ? "Buzz keeps your sign-in in your system keychain until you sign out."
    : "Your credential stays in memory until you sign out or close Buzz.";

export function Login({
  session,
  available,
  active,
  showHeading = true,
  cancelOnUnmount = true,
  unavailableReason = "Open the Buzz desktop app to sign in with Builderlab.",
  openIdentity,
}: {
  session: BuilderlabSession;
  available: boolean;
  active(): boolean;
  showHeading?: boolean;
  /** Settings owns its pending login; shared app panels only observe it. */
  cancelOnUnmount?: boolean;
  unavailableReason?: string;
  /** Opens Identity, where an FI build's shared organization sign-in ends. */
  openIdentity?: (() => void) | undefined;
}) {
  const state = useSyncExternalStore(
    session.subscribe,
    session.snapshot,
    session.snapshot,
  );
  useEffect(
    () => () => {
      if (cancelOnUnmount && session.snapshot().status === "pending")
        session.abandon();
    },
    [cancelOnUnmount, session],
  );
  // A successful FI retry replaces the focused sign-in button with the
  // Identity link; focus follows only if the button still had it.
  const action = useRef(false);
  const identityLink = useRef<HTMLButtonElement>(null);
  const showsIdentity = nativeBuilderlab() && state.status === "signed-in";
  useEffect(() => {
    if (!showsIdentity || !action.current) return;
    action.current = false;
    identityLink.current?.focus();
  }, [showsIdentity]);
  const intro =
    state.status === "signed-in"
      ? kept()
      : `Connect your Builderlab account. ${kept()}`;
  return (
    <div data-buzz-ui="" className="grid gap-3">
      {showHeading ? <Header title="Builderlab" subtitle={intro} /> : null}
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
                {state.checking
                  ? "Checking your Builderlab sign-in…"
                  : state.status === "pending"
                    ? "Finish sign-in in your browser, then return to Buzz."
                    : state.account
                      ? state.account.email
                        ? state.account.email
                        : "Signed in to Builderlab."
                      : "Sign in securely in your browser."}
              </p>
              {showsIdentity ? (
                // The native session is shared with community sign-in, so it
                // ends only where that sign-in is managed.
                <p className="m-0 text-body-sm text-secondary">
                  Builderlab uses your organization sign-in. To sign out, go to{" "}
                  {openIdentity ? (
                    <Button
                      ref={identityLink}
                      variant="link"
                      size="inline"
                      onClick={() => {
                        if (active()) openIdentity();
                      }}
                    >
                      Identity → Organization sign-in
                    </Button>
                  ) : (
                    "Identity → Organization sign-in"
                  )}
                  .
                </p>
              ) : (
                <Button
                  variant={
                    state.status === "signed-out" ? "prominent" : "subtle"
                  }
                  size="sm"
                  loading={state.checking === true}
                  ref={(node) => {
                    if (!node) return;
                    // React detaches the ref before removing the node.
                    return () => {
                      action.current = document.activeElement === node;
                    };
                  }}
                  onClick={() => {
                    if (!active()) return;
                    if (state.status === "pending") session.cancel();
                    else if (state.status === "signed-in") session.signOut();
                    else void session.signIn();
                  }}
                >
                  {state.checking
                    ? "Checking sign-in"
                    : state.status === "pending"
                      ? "Cancel sign-in"
                      : state.status === "signed-in"
                        ? "Sign out"
                        : "Sign in with Builderlab"}
                </Button>
              )}
            </dd>
          </dl>
          {state.error && (
            <p role="alert" className="m-0 text-body-sm text-danger">
              {state.error}
            </p>
          )}
          {!showHeading && (
            <p className="m-0 text-caption text-secondary">{kept()}</p>
          )}
        </>
      )}
    </div>
  );
}
