import { useEffect, useState } from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Input } from "../../shared/design-system/ui/Input";
import { PrivateKey } from "./PrivateKey";
import type { Identity } from "./service";

export const WIPE_PHRASE = "wipe all my data";

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

/** Native refusals carry `{ message, reopen }`; anything else is a plain error. */
function signOutFailure(reason: unknown) {
  if (
    typeof reason === "object" &&
    reason !== null &&
    "message" in reason &&
    typeof reason.message === "string"
  )
    return {
      message: reason.message,
      reopen: "reopen" in reason && reason.reopen === true,
    };
  return { message: String(reason), reopen: false };
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
  // Agents may already be stopped; only reopening Buzz can finish or recover.
  const [reopen, setReopen] = useState(false);
  // Asked of the native side, which enforces it; wipe stays off until it answers.
  const [wipeRefusal, setWipeRefusal] = useState<string | null>();
  useEffect(() => {
    let current = true;
    identity
      .wipeRefusal()
      .catch(() => "Couldn’t check whether wipe is available")
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
    try {
      await identity.signOut({ wipe, removeAgents: wipe && removeAgents });
    } catch (reason) {
      const failure = signOutFailure(reason);
      setError(failure.message);
      setReopen(failure.reopen);
      setPending(failure.reopen);
    }
  }
  return (
    <AlertDialog
      title="Sign out of Buzz?"
      description="Buzz restarts and removes your private key from this device. Without your key you can’t sign back in as this identity, so save it first."
      onClose={onClose}
      pending={pending && !reopen}
      actions={
        <>
          <Button type="button" disabled={pending && !reopen} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!ready || pending || reopen}
            onClick={() => void confirm()}
          >
            {wipe ? "Sign out and wipe" : "Sign out"}
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
          label="Also wipe this device’s Buzz data"
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
              Wipe clears this app’s data, local storage, caches and plugin
              storage on this device only. It can’t reach your clipboard, keys
              you exported, or relay data; your npub and its history stay on the
              relays.
              {!removeAgents &&
                " Kept agents keep their list, settings (including any API keys entered there) and keys; their saved logins and logs are wiped. Kept Databricks agents need reconnecting through Browse models."}
            </p>
          </>
        )}
        {!wipe && (
          <p className="text-body-sm text-muted">
            Your local data stays on this device, so signing back in with the
            same key finds it. Agents are kept and start again only for this
            key.
          </p>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
    </AlertDialog>
  );
}
