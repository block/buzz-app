import { OnboardingBack } from "./OnboardingBack";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import type { Recovery } from "./builderlab-account";
import styles from "./IdentitySetup.module.css";
import { OnboardingScreen } from "./OnboardingScreen";
import { RestoreIdentity } from "./RestoreIdentity";
import { recoveryOff } from "./service";

/**
 * Pause after Welcome back's Restore from backup: native recovery's browser
 * sign-in, then the linked key's backup to install. Where recovery is
 * unavailable or refused, which no retry changes, or every backup came back
 * and none holds the linked key, the page offers Enter your private key
 * instead of Try again; a backup that failed to come back keeps the retry.
 */
export function KeyRestore({
  recovery,
  expectedPubkey,
  onBack,
  onLost,
  onImport,
  onInstalled,
}: {
  recovery: Recovery;
  /** The hex key linked to the account: the only one restored. */
  expectedPubkey: string;
  /** Recovery was canceled: return to Welcome back. */
  onBack: () => void;
  onLost?: (() => void) | undefined;
  /** Recovery was canceled: open the import page. */
  onImport: () => void;
  /** Installing settled, restored or not. */
  onInstalled: () => void;
}) {
  const state = useSyncExternalStore(recovery.subscribe, recovery.snapshot);
  const candidate =
    state?.status === "choosing"
      ? state.candidates.find((item) => item.pubkey === expectedPubkey)
      : undefined;
  const installedHandle = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!candidate || installedHandle.current === candidate.handle) return;
    installedHandle.current = candidate.handle;
    void recovery.installRecovery(candidate.handle).then(onInstalled);
  }, [candidate, recovery, onInstalled]);
  // A recovery holds the identity busy, so leaving cancels it first.
  const leave = (then: () => void) => () =>
    recovery.cancelRecovery().then((canceled) => {
      if (canceled) then();
      return canceled;
    });
  const off = recoveryOff(state);
  // "Stored securely" holds only while a restore may still install the key:
  // an outcome that restored nothing explains itself below.
  const restoring =
    state?.status === "waiting" ||
    (state?.status === "choosing" &&
      state.candidates.some(
        (candidate) => candidate.pubkey === expectedPubkey,
      ));
  return (
    <OnboardingScreen
      labelledBy="welcome-title"
      intro={
        // The frame already centres and pads this column: no `.setup` wrapper.
        <div className={`${styles.setupContent} w-full max-w-md flex-1`}>
          <h1
            id="welcome-title"
            tabIndex={-1}
            className="text-heading text-standard"
          >
            Restore from backup
          </h1>
          {(off || restoring) && (
            <p className="text-body text-subtle">
              {off
                ? "Backup restore isn’t available for this account. Enter your private key to continue."
                : "Restoring your key securely on this device."}
            </p>
          )}
          {onLost && !candidate && state?.status !== "saving" && (
            <Button variant="link" onClick={() => void leave(onLost)()}>
              I lost this key
            </Button>
          )}
          {off ? (
            // Footer order: secondary first, primary last.
            <div data-onboarding-actions="">
              <OnboardingBack onClick={() => void leave(onBack)()} />
              <Button
                variant="prominent"
                size="lg"
                onClick={() => void leave(onImport)()}
              >
                Enter your private key
              </Button>
            </div>
          ) : state ? (
            <RestoreIdentity
              identity={{
                // The service keeps a live attempt that recovered something;
                // a retry over one first cancels it, and only when that held.
                beginRecovery: async () => {
                  if (await recovery.cancelRecovery())
                    await recovery.beginRecovery();
                },
                cancelRecovery: leave(onBack),
                installRecovery: (handle) =>
                  recovery.installRecovery(handle).then(onInstalled),
              }}
              recovery={candidate ? { status: "saving" } : state}
              expectedPubkey={expectedPubkey}
              onImport={() => void leave(onImport)()}
            />
          ) : null}
        </div>
      }
    >
      {null}
    </OnboardingScreen>
  );
}
