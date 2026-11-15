import { useRef, useState, useSyncExternalStore } from "react";
import { npubEncode } from "nostr-tools/nip19";
import { invoke } from "@tauri-apps/api/core";
import { prepareRemoteAgentAuthorization } from "../features/host/service";
import {
  identityAnswerUrl,
  type IdentityRequest,
  type IdentityRequests,
} from "../features/identity/identity-requests";
import { AlertDialog } from "../shared/design-system/ui/AlertDialog";
import { Button } from "../shared/design-system/ui/Button";
import { Field } from "../shared/design-system/ui/Field";
import { Textarea } from "../shared/design-system/ui/Textarea";

const answer = (url: string) => invoke("plugin:opener|open_url", { url });

/** A website's `buzz://authorize-identity` request: the Security settings
 * proof, signed only after the owner approves and returned to that site. */
export function IdentityRequestDialog({
  requests,
}: {
  requests: IdentityRequests;
}) {
  const pending = useSyncExternalStore(requests.subscribe, requests.snapshot);
  if (!pending) return null;
  return (
    <Consent
      // A newer request is a new decision.
      key={`${pending.request.state}:${pending.viewer}`}
      request={pending.request}
      viewer={pending.viewer}
      close={requests.close}
    />
  );
}

function Consent({
  request,
  viewer,
  close,
}: {
  request: IdentityRequest;
  viewer: string;
  close: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(
    request.pubkey === viewer
      ? "This site asked to authorize your own key. Buzz never does that."
      : "",
  );
  const cancelButton = useRef<HTMLButtonElement>(null);
  const operation = useRef<AbortController | null>(null);

  function deny() {
    operation.current?.abort();
    close();
    void answer(identityAnswerUrl(request, "denied")).catch(() => {});
  }

  async function authorize() {
    if (operation.current || error) return;
    const attempt = new AbortController();
    operation.current = attempt;
    setPending(true);
    try {
      const proof = await prepareRemoteAgentAuthorization(
        request.pubkey,
        attempt.signal,
      );
      if (attempt.signal.aborted) return;
      if (proof[1] !== viewer)
        throw new Error("Your Buzz identity changed. Ask the site again.");
      await answer(identityAnswerUrl(request, { proof }));
      close();
    } catch (failure) {
      if (attempt.signal.aborted) return;
      operation.current = null;
      setPending(false);
      setError(
        failure instanceof Error
          ? failure.message
          : "Couldn’t authorize this identity.",
      );
    }
  }

  const host = new URL(request.origin).host;
  return (
    <AlertDialog
      title={`Authorize ${host}?`}
      description={`${request.origin} asks you to authorize its own key. The holder of this key can act as your agent, including directing your Buzz coding agents to run commands as you. This permission has no time or event-kind limits.`}
      initialFocus={cancelButton}
      onClose={deny}
      actions={
        <>
          <Button ref={cancelButton} onClick={deny}>
            Deny
          </Button>
          <Button
            variant="prominent"
            loading={pending}
            disabled={!!error}
            onClick={() => void authorize()}
          >
            {pending ? "Authorizing…" : "Authorize this key"}
          </Button>
        </>
      }
    >
      <Field label="Application identity (npub)" error={error}>
        <Textarea
          variant="code"
          readOnly
          value={npubEncode(request.pubkey)}
          rows={2}
        />
      </Field>
    </AlertDialog>
  );
}
