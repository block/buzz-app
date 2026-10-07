import { useState } from "react";
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
  const ready = signOutReady({ touched, haveKey, wipe, phrase });
  async function confirm() {
    setPending(true);
    setError("");
    try {
      await identity.signOut({ wipe, removeAgents: wipe && removeAgents });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPending(false);
    }
  }
  return (
    <AlertDialog
      title="Sign out of Buzz?"
      description="Buzz restarts and removes your private key from this device. Without your key you can’t sign back in as this identity, so save it first."
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
          disabled={pending}
          onCheckedChange={(checked) => {
            setWipe(checked);
            if (!checked) {
              setRemoveAgents(false);
              setPhrase("");
            }
          }}
        />
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
              Wipe removes this identity from this device only. It can’t reach
              your clipboard, keys you exported, or relay data; your npub and
              its history stay on the relays.
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
