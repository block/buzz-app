import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
      // A newer opening is a new decision, even of the same link.
      key={pending.id}
      request={pending.request}
      viewer={pending.viewer}
      close={() => requests.close(pending.id)}
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
  const ownKey = request.pubkey === viewer;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const cancelButton = useRef<HTMLButtonElement>(null);
  const operation = useRef<AbortController | null>(null);
  // A replaced or closed request's signing must not answer or close anything.
  useEffect(() => () => operation.current?.abort(), []);

  function deny() {
    // Once approval is under way its answer may already be on its way.
    if (operation.current) return;
    close();
    void answer(identityAnswerUrl(request, "denied")).catch(() => {});
  }

  async function authorize() {
    if (operation.current || ownKey) return;
    const attempt = new AbortController();
    operation.current = attempt;
    setPending(true);
    setError("");
    try {
      const proof = await prepareRemoteAgentAuthorization(
        request.pubkey,
        attempt.signal,
      );
      if (attempt.signal.aborted) return;
      if (proof[1] !== viewer)
        throw new Error("Your Buzz identity changed. Ask the site again.");
      await answer(identityAnswerUrl(request, { proof }));
      if (attempt.signal.aborted) return;
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
      pending={pending}
      actions={
        <>
          <Button ref={cancelButton} disabled={pending} onClick={deny}>
            Deny
          </Button>
          <Button
            variant="prominent"
            loading={pending}
            disabled={ownKey}
            onClick={() => void authorize()}
          >
            {pending ? "Authorizing…" : "Authorize this key"}
          </Button>
        </>
      }
    >
      <Field
        label="Application identity (npub)"
        error={
          ownKey
            ? "This site asked to authorize your own key. Buzz never does that."
            : error
        }
      >
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
