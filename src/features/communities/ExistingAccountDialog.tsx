import { useEffect, useState, useSyncExternalStore } from "react";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Button } from "../../shared/design-system/ui/Button";
import type { AccountConnection } from "./account-connection";

export function ExistingAccountDialog({
  connection,
  close,
}: {
  connection: AccountConnection;
  close(): void;
}) {
  const [pin, setPin] = useState("");
  const [relay, setRelay] = useState("");
  const state = useSyncExternalStore(connection.subscribe, connection.snapshot);
  useEffect(() => () => connection.cancel(), [connection]);
  const busy = state.status === "checking";
  return (
    <Dialog
      open
      title="Use an existing Buzz account"
      onOpenChange={(open) => {
        if (!open) {
          connection.cancel();
          close();
        }
      }}
    >
      {state.account ? (
        <div className="space-y-4">
          <p>
            {state.status === "disconnecting"
              ? "Disconnecting native account…"
              : state.error
                ? "Native connection needs attention"
                : "Native connection open for this session."}
          </p>
          {state.error && <p role="alert">{state.error}</p>}
          <p className="text-body-sm">{state.account.origin}</p>
          <p className="text-body-sm">
            Membership is checked by the relay. Channel reads and ordinary sends
            and live updates are available. Activity capture follows the
            Activity plugin setting. Saved Activity is available from agent
            profiles and response disclosures. Uploads and account changes are
            not available. Closing this dialog keeps the connection; app restart
            requires explicit connection again.
          </p>
          <Button
            disabled={state.status === "disconnecting"}
            onClick={() => void connection.disconnect()}
          >
            Disconnect native account
          </Button>
        </div>
      ) : (
        <form
          className="space-y-6"
          onSubmit={(event) => {
            event.preventDefault();
            void connection.check(pin, relay);
          }}
        >
          <p className="text-body-sm">
            On this Mac, verify the account saved by installed Buzz. Your
            private key stays in native memory until disconnect or app close,
            never in the webview or a new credential store. Connect authorizes
            Keychain access and authenticated reads at the relay below. Messages
            are sent only through your sends or recovery of previously queued
            messages.
          </p>
          <Field
            label="Expected public key"
            description="Your npub or 64-character public key, never an nsec or private key."
          >
            <Input
              value={pin}
              onChange={(event) => {
                connection.cancel();
                setPin(event.target.value);
              }}
              disabled={busy}
              required
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field
            label="Relay URL"
            description="An existing community's https:// or wss:// origin. Connecting does not join or publish a profile."
          >
            <Input
              value={relay}
              onChange={(event) => {
                connection.cancel();
                setRelay(event.target.value);
              }}
              disabled={busy}
              required
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          {busy && (
            <p role="status">
              Checking account and relay… Respond to macOS if it asks for
              Keychain access.
            </p>
          )}
          {state.error && <p role="alert">{state.error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              Connect existing account
            </Button>
            {busy && (
              <Button type="button" variant="ghost" onClick={connection.cancel}>
                Cancel check
              </Button>
            )}
          </div>
        </form>
      )}
    </Dialog>
  );
}
