import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { launchVisible, setLaunchReady } from "../../app/launch";
import { OnboardingScreen } from "../identity/OnboardingScreen";
import styles from "../identity/IdentitySetup.module.css";
import { recoveryMessage } from "./CommunitySignIn";
import type { FederatedIdentity, SessionSnapshot } from "./service";

/** Failures that mean this desktop has no native session owner at all. */
const NO_HOST = new Set(["desktop-required", "native-unavailable"]);

function needsSignIn(state: SessionSnapshot) {
  return (
    state.status === "signed-out" ||
    state.status === "signing-in" ||
    state.status === "reauthentication-required" ||
    (state.status === "unavailable" && !NO_HOST.has(state.failure ?? ""))
  );
}

/**
 * Builds whose descriptor says `signIn: "at-launch"` sign in to the
 * organization before the app opens, and again whenever the session ends.
 * Other builds render `children` unchanged and sign in on demand.
 */
export function LaunchSignIn({
  identity,
  children,
}: {
  identity: FederatedIdentity;
  children: ReactNode;
}) {
  const state = useSyncExternalStore(
    identity.subscribe,
    identity.snapshot,
    identity.snapshot,
  );
  // The descriptor is compiled in, so this never changes during a run.
  const required =
    identity.apiAvailable && state.authority?.signIn === "at-launch";
  // "Not now" lasts until a session is established; a later end asks again.
  const [dismissed, setDismissed] = useState(false);
  if (dismissed && state.status === "signed-in") setDismissed(false);
  const showing = required && !dismissed && needsSignIn(state);
  // The app mounts once, after launch settles, and then stays mounted (hidden
  // and inert) under a later sign-in, so drafts and navigation survive it.
  const [opened, setOpened] = useState(false);
  const settled = !showing && state.status !== "restoring";
  if (required && !opened && settled) setOpened(true);

  // Start the browser sign-in only when this screen is why it opens: the
  // first settled state of the run, and a session ending. Never after a
  // cancel, a failure or a sign-out, which leave the choice to the person.
  const previous = useRef<SessionSnapshot["status"] | null>(null);
  useEffect(() => {
    const from = previous.current;
    if (state.status === "restoring") return;
    previous.current = state.status;
    if (!required || dismissed) return;
    const launch =
      from === null &&
      (state.status === "signed-out" ||
        state.status === "reauthentication-required");
    const ended =
      from === "signed-in" && state.status === "reauthentication-required";
    if (launch || ended) void identity.signIn().catch(() => {});
  }, [identity, required, dismissed, state.status]);

  // The launch mark covers the window until something is ready to show.
  useEffect(() => {
    if (showing && launchVisible()) setLaunchReady(true);
  }, [showing]);

  // Return focus to where it was in the app when a session ends mid-run.
  const focus = useRef<HTMLElement | null>(null);
  const app = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const remember = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement) focus.current = event.target;
    };
    element.addEventListener("focusin", remember);
    return () => element.removeEventListener("focusin", remember);
  }, []);
  useLayoutEffect(() => {
    if (!showing && focus.current?.isConnected) focus.current.focus();
  }, [showing]);

  if (!required) return children;
  return (
    <>
      {showing && (
        <SignInScreen
          identity={identity}
          state={state}
          dismiss={() => setDismissed(true)}
        />
      )}
      {opened && (
        // Preflight's `[hidden]` rule outranks `contents` while it is set.
        <div ref={app} className="contents" hidden={showing} inert={showing}>
          {children}
        </div>
      )}
    </>
  );
}

function SignInScreen({
  identity,
  state,
  dismiss,
}: {
  identity: FederatedIdentity;
  state: SessionSnapshot;
  dismiss(): void;
}) {
  const [failure, setFailure] = useState("");
  const organization = state.authority?.organization ?? null;
  const name = organization ?? "your organization";
  const communities = organization
    ? `${organization}’s communities`
    : "your organization’s communities";
  const signingIn = state.status === "signing-in";
  const unreachable = state.status === "unavailable";
  const ended = state.status === "reauthentication-required";
  const stored = unreachable && !!state.failure?.startsWith("storage-");
  // Code-only failures; the description already covers expiry and the network.
  const problem =
    failure ||
    (state.failure &&
    !signingIn &&
    !unreachable &&
    state.failure !== "reauthentication-required"
      ? state.failure
      : "");
  function run(operation: () => Promise<unknown>) {
    setFailure("");
    void operation().catch((error: unknown) =>
      setFailure(error instanceof Error ? error.message : "sign-in-failed"),
    );
  }
  const title = signingIn
    ? `Signing you in to ${name}`
    : stored
      ? "Couldn’t open your saved sign-in"
      : unreachable
        ? `Couldn’t reach ${name} sign-in`
        : ended
          ? `Sign in to ${name} again`
          : `Sign in to ${name}`;
  const description = signingIn
    ? "Finish signing in in your browser. Buzz opens as soon as you’re done."
    : stored
      ? recoveryMessage(state.failure ?? "")
      : unreachable
        ? "Check your connection, then try again."
        : ended
          ? `Your sign-in has ended. Sign in again to keep using ${communities}.`
          : `Buzz uses your ${organization ? `${organization} ` : ""}account to open ${communities}.`;
  return (
    <OnboardingScreen
      labelledBy="launch-sign-in-title"
      intro={
        <>
          <h1 id="launch-sign-in-title" className="text-heading">
            {title}
          </h1>
          <p className={styles.tagline}>{description}</p>
        </>
      }
    >
      {problem && (
        <p role="alert" className="text-body-sm text-danger">
          {recoveryMessage(problem)}
        </p>
      )}
      {signingIn ? (
        <>
          <p role="status" className="sr-only">
            Waiting for you to finish signing in.
          </p>
          <Button
            size="lg"
            variant="subtle"
            onClick={() =>
              run(async () => {
                await identity.cancelSignIn();
                await identity.signIn();
              })
            }
          >
            Open the sign-in page again
          </Button>
          <Button
            size="lg"
            variant="ghost"
            onClick={() => run(() => identity.cancelSignIn())}
          >
            Cancel
          </Button>
        </>
      ) : (
        <>
          <Button
            autoFocus
            size="lg"
            variant="prominent"
            onClick={() => run(() => identity.signIn())}
          >
            {unreachable
              ? "Try again"
              : organization
                ? `Sign in with ${organization}`
                : "Sign in"}
          </Button>
          <Button size="lg" variant="ghost" onClick={dismiss}>
            Not now
          </Button>
        </>
      )}
    </OnboardingScreen>
  );
}
