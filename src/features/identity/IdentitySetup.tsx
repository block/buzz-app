import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { isTauri } from "@tauri-apps/api/core";
import {
  hasIntegratedWindowControls,
  WindowControls,
} from "../../app/shell/WindowControls";
import { macTitleBarDragHandlers } from "../../app/shell/title-bar";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import type { Identity } from "./service";
import { RestoreIdentity } from "./RestoreIdentity";
import styles from "./IdentitySetup.module.css";
import { OnboardingWordmark } from "./OnboardingWordmark";

export function IdentitySetup({
  identity,
  children,
}: {
  identity: Identity;
  children: ReactNode;
}) {
  const state = useSyncExternalStore(identity.subscribe, identity.snapshot);
  const [importing, setImporting] = useState(false);
  const [nsec, setNsec] = useState("");
  const [backupAvailable, setBackupAvailable] = useState(false);
  const [legacyAvailable, setLegacyAvailable] = useState(false);
  const missing = state.status === "missing";
  useEffect(() => {
    if (!missing) return;
    let active = true;
    void identity.backupAvailable().then(
      (available) => active && setBackupAvailable(available),
      () => active && setBackupAvailable(false),
    );
    void identity.legacyAvailable().then(
      (available) => active && setLegacyAvailable(available),
      () => active && setLegacyAvailable(false),
    );
    return () => {
      active = false;
    };
  }, [identity, missing]);
  useEffect(
    () => () => {
      void identity.cancelRecovery();
    },
    [identity],
  );
  const macDesktop = isTauri() && /Mac/i.test(navigator.platform);
  const integratedWindowControls = hasIntegratedWindowControls();
  if (state.status === "ready") return children;
  if (missing && !importing && !state.recovery) {
    return (
      <main className={styles.landing} aria-labelledby="identity-landing-title">
        <header
          className={styles.titlebar}
          data-buzz-window-drag=""
          data-tauri-drag-region={integratedWindowControls || undefined}
          {...(macDesktop ? macTitleBarDragHandlers : {})}
        >
          {(macDesktop || integratedWindowControls) && <WindowControls />}
        </header>
        <div className={styles.content}>
          <div className={styles.brand}>
            <h1 id="identity-landing-title" className={styles.wordmark}>
              <OnboardingWordmark />
            </h1>
            <p className={styles.tagline}>
              Your people, your agents, your projects —<br />
              all in one place.
            </p>
          </div>
          <div className={styles.actions}>
            {state.error && <p role="alert">{state.error}</p>}
            {legacyAvailable && (
              <Button
                size="lg"
                disabled={state.busy}
                onClick={() => void identity.importLegacy()}
              >
                Continue with your Buzz identity
              </Button>
            )}
            <Button
              size="lg"
              variant="prominent"
              disabled={state.busy}
              onClick={() => void identity.create()}
            >
              Create a new identity
            </Button>
            <Button
              size="lg"
              variant="ghost"
              disabled={state.busy}
              onClick={() => setImporting(true)}
            >
              Use an existing key
            </Button>
            {backupAvailable && (
              <Button
                size="lg"
                variant="ghost"
                disabled={state.busy}
                onClick={() => void identity.beginRecovery()}
              >
                Restore from backup
              </Button>
            )}
            {state.busy && <p role="status">Saving your identity securely…</p>}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.landing} aria-labelledby="identity-setup-title">
      {(macDesktop || integratedWindowControls) && (
        <header
          className={styles.titlebar}
          data-buzz-window-drag=""
          data-tauri-drag-region={integratedWindowControls || undefined}
          {...(macDesktop ? macTitleBarDragHandlers : {})}
        >
          <WindowControls />
        </header>
      )}
      <section
        className={`${styles.setup} ${importing ? styles.importSetup : ""}`}
      >
        <div className={importing ? styles.importContent : styles.setupContent}>
          <h1 id="identity-setup-title" className="text-heading">
            {importing ? "Use your existing identity" : "Your Buzz identity"}
          </h1>
          {state.status === "loading" ? (
            <p role="status">Opening your saved identity…</p>
          ) : state.status === "error" ? (
            <>
              <p role="alert">{state.error}</p>
              <Button onClick={() => void identity.retry()}>
                Retry secure storage access
              </Button>
            </>
          ) : (
            <>
              {!importing && (
                <p>
                  Your key is stored securely on this device. No community is
                  joined automatically.
                </p>
              )}
              {state.error && <p role="alert">{state.error}</p>}
              {state.recovery ? (
                <RestoreIdentity
                  identity={identity}
                  recovery={state.recovery}
                />
              ) : importing ? (
                <form
                  id="identity-import-form"
                  className={styles.importForm}
                  onSubmit={(event) => {
                    event.preventDefault();
                    const supplied = nsec;
                    setNsec("");
                    void identity.importKey(supplied);
                  }}
                >
                  <Field label="Private key (nsec)" controlId="import-nsec">
                    <Input
                      id="import-nsec"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={nsec}
                      disabled={state.busy}
                      onChange={(event) => setNsec(event.target.value)}
                    />
                  </Field>
                </form>
              ) : null}
              {state.busy && !state.recovery && (
                <p role="status">Saving your identity securely…</p>
              )}
            </>
          )}
        </div>
        {importing && state.status === "missing" && !state.recovery && (
          <div className={styles.actions}>
            <Button
              type="submit"
              form="identity-import-form"
              size="lg"
              variant="prominent"
              disabled={state.busy || !nsec.trim()}
            >
              Import this identity
            </Button>
            <Button
              type="button"
              size="lg"
              variant="ghost"
              disabled={state.busy}
              onClick={() => {
                setNsec("");
                setImporting(false);
              }}
            >
              Back
            </Button>
          </div>
        )}
      </section>
    </main>
  );
}
