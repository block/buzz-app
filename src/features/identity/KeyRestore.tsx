import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { npubEncode } from "nostr-tools/nip19";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
import { publicKeyLabels } from "../../shared/identity/public-key";
import type { Recovery } from "./builderlab-account";
import { OnboardingBack } from "./OnboardingBack";
import { OnboardingScreen } from "./OnboardingScreen";
import { recoveryOff } from "./service";

/**
 * First-run recovery installs the key linked to the current account. When
 * recovery signed into that same account (`subject`) and returned another
 * key, the user picks one, the linked key preselected; another key is
 * relinked by the caller once installed. A different account's backups only
 * ever yield the linked key. With no linked key, the user picks any of the
 * account's own backups, which the caller links once installed.
 */
export function KeyRestore({
  recovery,
  expectedPubkey,
  subject,
  preferredPubkey,
  email,
  onBack,
  onLost,
  onImport,
  onInstalled,
}: {
  recovery: Recovery;
  /** The account's linked key; none when it has none. */
  expectedPubkey?: string | undefined;
  /** The signed-in account's subject, which recovery's must match to offer other keys. */
  subject?: string | undefined;
  /** Preselected over the linked key when listed: the key Settings chose to switch to. */
  preferredPubkey?: string | undefined;
  email?: string | undefined;
  onBack: () => void;
  onLost?: (() => void) | undefined;
  onImport: () => void;
  onInstalled: () => void;
}) {
  const state = useSyncExternalStore(recovery.subscribe, recovery.snapshot);
  const choices = state?.status === "choosing" ? state.candidates : [];
  const picking =
    state?.status === "choosing" &&
    !!subject &&
    state.subject === subject &&
    choices.some((item) => item.pubkey !== expectedPubkey);
  const candidate = picking
    ? undefined
    : choices.find((item) => item.pubkey === expectedPubkey);
  const [picked, setPicked] = useState<string>();
  const handle = choices.some((item) => item.handle === picked)
    ? picked
    : (
        choices.find((item) => item.pubkey === preferredPubkey) ??
        choices.find((item) => item.pubkey === expectedPubkey)
      )?.handle;
  const labels = publicKeyLabels(choices.map((item) => item.pubkey));
  const installedHandle = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!candidate || installedHandle.current === candidate.handle) return;
    installedHandle.current = candidate.handle;
    void recovery.installRecovery(candidate.handle).then(onInstalled);
  }, [candidate, recovery, onInstalled]);
  const leave = async (then: () => void) => {
    if (await recovery.cancelRecovery()) then();
  };
  const retry = async () => {
    if (!(await recovery.cancelRecovery())) return;
    installedHandle.current = undefined;
    await recovery.beginRecovery();
  };
  const saving = !!candidate || state?.status === "saving";
  const canceling = state?.status === "canceling";
  const failed =
    state?.status === "error" ||
    (state?.status === "choosing" && !picking && !candidate);
  const partial = state?.status === "choosing" && state.failedCount > 0;
  const off = recoveryOff(state);
  const canRetry = !off && (state?.status === "error" || partial);
  const description = off
    ? "Backup restoration isn’t available for this account. Enter your private key to continue."
    : partial
      ? "We couldn’t check all your backups. Try again, or enter your private key if you have a copy."
      : state?.status === "choosing" && !candidate
        ? state.candidates.length === 0
          ? "We couldn’t find a key backup in this Builderlab account. If you have a copy of your private key, you can enter it instead."
          : "We found backups, but none contains the key linked to your account. Enter your private key to continue."
        : failed
          ? "Try again, or enter your private key if you have a copy."
          : saving
            ? "Restoring your key…"
            : canceling
              ? "Canceling recovery…"
              : "Restoring your key…";
  return (
    <OnboardingScreen
      labelledBy="welcome-title"
      intro={
        <>
          <h1
            id="welcome-title"
            tabIndex={-1}
            className="text-heading text-standard"
          >
            {failed ? "Couldn’t restore your key" : "Restore your key"}
          </h1>
          {email && (
            <p className="break-words text-body-sm text-subtle">
              Signed in as {email}
            </p>
          )}
          <p
            role={failed ? "alert" : "status"}
            className="mt-2 text-body text-subtle"
          >
            {picking
              ? `Choose the identity to restore on this device. Restoring another identity links it to your account in place of the current one.${partial ? " Some backups couldn’t be recovered." : ""}`
              : description}
          </p>
          {state?.status === "waiting" && (
            <p className="text-body-sm text-subtle">
              Complete sign-in in your browser if prompted.
            </p>
          )}
        </>
      }
    >
      {picking && (
        <Field label="Identity to restore" nativeLabel={false}>
          <RadioGroup
            aria-label="Identity to restore"
            value={handle ?? null}
            onValueChange={(value) => value && setPicked(value)}
          >
            {choices.map((item) => (
              <Radio
                key={item.handle}
                value={item.handle}
                label={labels.get(item.pubkey)}
                description={
                  <>
                    {item.pubkey === expectedPubkey
                      ? "Linked identity"
                      : "Other identity"}
                    <code className="block break-all text-mono">
                      {npubEncode(item.pubkey)}
                    </code>
                  </>
                }
              />
            ))}
          </RadioGroup>
        </Field>
      )}
      {(failed || picking) && (
        <>
          <Button
            size="lg"
            variant={failed ? "prominent" : "subtle"}
            onClick={() => void leave(onImport)}
          >
            Enter my private key
          </Button>
          {onLost && (
            <Button size="lg" onClick={() => void leave(onLost)}>
              I lost my key
            </Button>
          )}
          {canRetry && (
            <Button size="lg" variant="ghost" onClick={() => void retry()}>
              Try again
            </Button>
          )}
        </>
      )}
      <div data-onboarding-actions="">
        <OnboardingBack
          aria-label={!failed && !saving ? "Cancel" : "Back"}
          disabled={saving || canceling}
          onClick={() => void leave(onBack)}
        />
        {picking && (
          <Button
            size="lg"
            variant="primary"
            disabled={!handle}
            onClick={() =>
              handle && void recovery.installRecovery(handle).then(onInstalled)
            }
          >
            Restore this identity
          </Button>
        )}
      </div>
    </OnboardingScreen>
  );
}
