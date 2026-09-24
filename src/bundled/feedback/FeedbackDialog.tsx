import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { OutgoingEvent } from "../../features/relay/outbox";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import {
  feedbackEvent,
  PRODUCT_FEEDBACK_KIND,
  type FeedbackCategory,
} from "../../features/relay/product-feedback";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Textarea } from "../../shared/design-system/ui/Textarea";

const categories = [
  ["bug", "Bug"],
  ["praise", "Praise"],
  ["needs-work", "Needs work"],
] as const;
const emptyItems: readonly OutgoingEvent[] = [];
const emptyEntries = () => emptyItems;
const noSubscription = () => () => {};
const sessionKeys = new WeakMap<object, number>();
let nextSessionKey = 0;
function sessionKey(session: object): number {
  let key = sessionKeys.get(session);
  if (key === undefined) {
    key = ++nextSessionKey;
    sessionKeys.set(session, key);
  }
  return key;
}

export function FeedbackDialog({
  open,
  onOpenChange,
  relay,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  relay: RelayData;
}) {
  const connection = useSyncExternalStore(relay.subscribe, relay.snapshot);
  const identity = sessionKey(connection.session);
  // Session identity, unlike generation, distinguishes already-connected deployments.
  return (
    <FeedbackForConnection
      key={identity}
      open={open}
      onOpenChange={onOpenChange}
      connection={connection}
      isCurrent={() => relay.snapshot().session === connection.session}
    />
  );
}

function FeedbackForConnection({
  open,
  onOpenChange,
  connection,
  isCurrent,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  connection: RelaySnapshot;
  isCurrent(): boolean;
}) {
  const active = useRef(false);
  const dialogEpoch = useRef(0);
  const lastOpen = useRef(open);
  if (lastOpen.current !== open) {
    dialogEpoch.current++;
    lastOpen.current = open;
  }
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      dialogEpoch.current++;
    };
  }, []);
  useEffect(() => {
    if (!open) setBusy(false);
  }, [open]);
  function close() {
    dialogEpoch.current++;
    onOpenChange(false);
  }
  const outbox = connection.session.outbox;
  const entries = useSyncExternalStore(
    outbox?.subscribe ?? noSubscription,
    outbox?.snapshot ?? emptyEntries,
  );
  const pending = entries.find(
    (item) => item.event.kind === PRODUCT_FEEDBACK_KIND,
  );
  const [category, setCategory] = useState<FeedbackCategory | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    let active = true;
    setHydrated(false);
    void outbox?.ready().then(
      () => {
        if (active) setHydrated(true);
      },
      (reason) => {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not load saved feedback.",
          );
      },
    );
    return () => {
      active = false;
    };
  }, [outbox]);
  const available =
    hydrated &&
    connection.status === "ready" &&
    !!outbox?.supports(PRODUCT_FEEDBACK_KIND);
  function submit() {
    if (!outbox || !available || pending || busy) return;
    try {
      outbox.send(feedbackEvent(message, category));
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not send feedback.",
      );
    }
  }
  async function finish() {
    if (!outbox || !pending || busy) return;
    setBusy(true);
    const epoch = dialogEpoch.current;
    try {
      await outbox.dismiss(pending.event.id);
      if (!active.current || !isCurrent() || epoch !== dialogEpoch.current)
        return;
      setMessage("");
      setCategory(null);
      setError("");
      close();
    } catch (reason) {
      if (!active.current || !isCurrent() || epoch !== dialogEpoch.current)
        return;
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not clear delivered feedback.",
      );
    } finally {
      if (active.current && isCurrent() && epoch === dialogEpoch.current)
        setBusy(false);
    }
  }
  function retry() {
    if (!outbox || !pending || !available || busy) return;
    try {
      outbox.retry(pending.event.id);
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not retry feedback.",
      );
    }
  }
  const delivered =
    pending?.delivery === "accepted" || pending?.delivery === "seen";
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
        else onOpenChange(next);
      }}
      title="Send feedback"
      description="Feedback goes to this Buzz deployment's private operator inbox, not a channel."
      actions={
        <>
          <Button onClick={close}>Close</Button>
          {delivered ? (
            <Button
              variant="prominent"
              disabled={busy}
              onClick={() => void finish()}
            >
              Done
            </Button>
          ) : pending?.delivery === "failed" ||
            pending?.delivery === "unknown" ? (
            <Button
              variant="prominent"
              disabled={!available || busy}
              onClick={retry}
            >
              Retry same feedback
            </Button>
          ) : !pending ? (
            <Button
              variant="prominent"
              disabled={!available || !message.trim() || busy}
              onClick={submit}
            >
              Send feedback
            </Button>
          ) : null}
        </>
      }
    >
      {pending ? (
        <>
          <p className="mb-4 whitespace-pre-wrap">{pending.event.content}</p>
          <p role="status">
            {delivered
              ? "Feedback received by the relay."
              : pending.delivery === "unknown"
                ? "Delivery could not be confirmed. Retry the same feedback; do not submit a duplicate."
                : pending.delivery === "failed"
                  ? `Feedback was not delivered. ${pending.error ?? "Retry to send."}`
                  : "Sending feedback…"}
          </p>
        </>
      ) : (
        <>
          <fieldset className="flex flex-wrap gap-2 mb-4">
            <legend className="sr-only">Feedback category (optional)</legend>
            {categories.map(([id, label]) => (
              <Button
                key={id}
                variant={category === id ? "prominent" : "subtle"}
                aria-pressed={category === id}
                onClick={() => setCategory(category === id ? null : id)}
              >
                {label}
              </Button>
            ))}
          </fieldset>
          <label htmlFor="feedback-message" className="text-label-sm">
            Your feedback
          </label>
          <Textarea
            id="feedback-message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Tell us what went wrong, or share general feedback."
          />
        </>
      )}
      {!available && (
        <p role="status">
          Connect to a Buzz deployment to send or retry feedback.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </Dialog>
  );
}
