import {
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { motion, useReducedMotion } from "motion/react";
import { Button } from "../../../shared/design-system/ui/Button";
import { Header } from "../../../shared/design-system/ui/Header";
import { browserLoginAvailable } from "../oauth/browser";
import type { OAuthSession } from "../oauth/session";

/** Account status replaces profile actions; the pane footer owns sign-in. */
export function createProfileActions(session: OAuthSession) {
  return function ProfileActions({ children }: { children: ReactNode }) {
    const login = useSyncExternalStore(session.subscribe, session.snapshot);
    if (login.status === "signed-in") return children;
    return (
      <span className="inline-flex items-center rounded-full bg-inset px-3 py-1 text-body-sm text-secondary">
        {login.status === "pending"
          ? "Signing in to Builderlab…"
          : "Signed out of Builderlab"}
      </span>
    );
  };
}

/** One account prompt for the whole hosted agent, independent of its active tab. */
export function createSignInFooter(session: OAuthSession) {
  return function SignInFooter() {
    const login = useSyncExternalStore(session.subscribe, session.snapshot);
    const [slow, setSlow] = useState(false);
    const title = useId();
    const reducedMotion = useReducedMotion();
    useEffect(() => {
      setSlow(false);
      if (login.status !== "pending") return;
      const timer = setTimeout(() => setSlow(true), 3000);
      return () => clearTimeout(timer);
    }, [login.status]);
    if (login.status === "signed-in") return null;
    const pending = login.status === "pending";
    const available = browserLoginAvailable();
    return (
      <motion.div
        initial={{ y: reducedMotion ? 0 : "100%", opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{
          duration:
            reducedMotion ||
            document.documentElement.hasAttribute("data-keyboard-navigation")
              ? 0
              : 0.22,
          ease: [0.23, 1, 0.32, 1],
        }}
      >
        <section
          aria-labelledby={title}
          className="floating-surface"
          style={{ "--floating-inset": "var(--space-5)" } as CSSProperties}
        >
          <div className="p-5">
            <Header
              id={title}
              title="Sign in to Builderlab"
              subtitle="Use your Builderlab account to access this agent."
            />
            <div className="grid gap-3">
              {(!available || pending) && (
                <p role="status" className="m-0 text-body-sm text-secondary">
                  {!available
                    ? "Open the Buzz desktop app to sign in with Builderlab."
                    : slow
                      ? "Finish sign-in in your browser, then return to Buzz."
                      : "Signing in to Builderlab…"}
                </p>
              )}
              {login.error && (
                <p role="alert" className="m-0 text-body-sm text-danger">
                  {login.error}
                </p>
              )}
              <Button
                variant={pending ? "outline" : "prominent"}
                size="lg"
                disabled={!available && !pending}
                style={{ width: "100%" }}
                onClick={() => {
                  if (pending) session.cancel();
                  else void session.signIn();
                }}
              >
                {pending ? "Cancel sign-in" : "Sign in to Builderlab"}
              </Button>
            </div>
          </div>
        </section>
      </motion.div>
    );
  };
}
