import { useEffect, useRef, useState } from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Input } from "../../shared/design-system/ui/Input";
import { PrivateKey } from "./PrivateKey";
import type { Identity } from "./service";

export const WIPE_PHRASE = "erase all my data";

/** Confirm only after the key was revealed or copied and the user says they have it. */
export function signOutReady(state: {
  touched: boolean;
  haveKey: boolean;
  wipe: boolean;
  phrase: string;
}) {
  return (
    state.touched &&
    state.haveKey &&
    (!state.wipe || state.phrase.trim() === WIPE_PHRASE)
  );
}

/** Native refusals carry `{ message }`; anything else is a plain error. */
export function signOutFailure(reason: unknown) {
  if (
    typeof reason === "object" &&
    reason !== null &&
    "message" in reason &&
    typeof reason.message === "string"
  )
    return reason.message;
  return String(reason);
}

/** Native offers this only when this build's own saved-credential setup is unfinished. */
export function offersSetupFinish(reason: unknown) {
  return (
    typeof reason === "object" &&
    reason !== null &&
    "finishSetup" in reason &&
    reason.finishSetup === true
  );
}

/** A stepped confirmation: success restarts Buzz, which qualifies the setup afresh. */
function FinishSetupDialog({
  identity,
  onBack,
}: {
  identity: Identity;
  onBack(): void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function finish() {
    setPending(true);
    setError("");
    try {
      await identity.finishCredentialSetup();
    } catch (reason) {
      setError(signOutFailure(reason));
      setPending(false);
    }
  }
  return (
    <AlertDialog
      title="Finish credential setup?"
      description="Buzz finishes setting up secure storage for saved plugin credentials on this device, then restarts. Nothing is signed out or removed. After it restarts, you can sign out again."
      onClose={onBack}
      pending={pending}
      initialFocus={cancel}
      actions={
        <>
          <Button
            ref={cancel}
            type="button"
            disabled={pending}
            onClick={onBack}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={pending}
            onClick={() => void finish()}
          >
            Finish and restart
          </Button>
        </>
      }
    >
      {error && <p role="alert">{error}</p>}
    </AlertDialog>
  );
}

export function SignOutDialog({
  identity,
  onClose,
}: {
  identity: Identity;
  onClose(): void;
}) {
  const [touched, setTouched] = useState(false);
  const [haveKey, setHaveKey] = useState(false);
  const [wipe, setWipe] = useState(false);
  const [removeAgents, setRemoveAgents] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [setupOffered, setSetupOffered] = useState(false);
  const [finishingSetup, setFinishingSetup] = useState(false);
  // Asked of the native side, which enforces it; wipe stays off until it answers.
  const [wipeRefusal, setWipeRefusal] = useState<string | null>();
  useEffect(() => {
    let current = true;
    identity
      .wipeRefusal()
      .catch(() => "Couldn’t check whether erasing is available")
      .then((reason) => {
        if (current) setWipeRefusal(reason ?? null);
      });
    return () => {
      current = false;
    };
  }, [identity]);
  const ready = signOutReady({ touched, haveKey, wipe, phrase });
  async function confirm() {
    setPending(true);
    setError("");
    setSetupOffered(false);
    try {
      await identity.signOut({ wipe, removeAgents: wipe && removeAgents });
    } catch (reason) {
      setError(signOutFailure(reason));
      setSetupOffered(offersSetupFinish(reason));
      setPending(false);
    }
  }
  if (finishingSetup)
    return (
      <FinishSetupDialog
        identity={identity}
        onBack={() => setFinishingSetup(false)}
      />
    );
  return (
    <AlertDialog
      title="Remove your key from this device?"
      description="Your private key is how you sign in to Buzz. This removes it from this device’s secure storage and signs you out of your organization, Builderlab and hosted communities. Account backups and copies saved elsewhere stay. Save a copy so you can sign back in."
      onClose={onClose}
      pending={pending}
      actions={
        <>
          <Button type="button" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!ready || pending}
            onClick={() => void confirm()}
          >
            {wipe ? "Remove and erase data" : "Remove from device"}
          </Button>
        </>
      }
    >
      <PrivateKey identity={identity} onInteraction={() => setTouched(true)} />
      <div className="mt-6 flex flex-col gap-3">
        <Checkbox
          label="I have my key"
          checked={haveKey}
          disabled={!touched || pending}
          onCheckedChange={setHaveKey}
        />
        <Checkbox
          label="Also erase everything else Buzz stores on this device"
          checked={wipe}
          disabled={pending || wipeRefusal !== null}
          onCheckedChange={(checked) => {
            setWipe(checked);
            if (!checked) {
              setRemoveAgents(false);
              setPhrase("");
            }
          }}
        />
        {wipeRefusal && (
          <p className="text-body-sm text-muted">{wipeRefusal}.</p>
        )}
        {wipe && (
          <>
            <Checkbox
              label="Also remove my agents"
              checked={removeAgents}
              disabled={pending}
              onCheckedChange={setRemoveAgents}
            />
            <label className="block text-label-sm" htmlFor="sign-out-phrase">
              Type “{WIPE_PHRASE}” to confirm
            </label>
            <Input
              id="sign-out-phrase"
              autoComplete="off"
              value={phrase}
              disabled={pending}
              onChange={(event) => setPhrase(event.currentTarget.value)}
            />
            <p className="text-body-sm text-muted">
              Erasing clears this app’s data, local storage, caches and plugin
              storage on this device only. It can’t reach your clipboard, keys
              you exported, or relay data; your npub and its history stay on the
              relays.
              {!removeAgents &&
                " Kept agents keep their names, types and keys; their settings on this device are erased."}
            </p>
          </>
        )}
        {!wipe && (
          <p className="text-body-sm text-muted">
            Your settings, agents and other Buzz data stay on this device. Sign
            back in with this key and they’ll be here. Agents start only for
            this key.
          </p>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {setupOffered && (
        <div className="mt-3">
          <Button
            type="button"
            disabled={pending}
            onClick={() => setFinishingSetup(true)}
          >
            Finish credential setup
          </Button>
        </div>
      )}
    </AlertDialog>
  );
}
