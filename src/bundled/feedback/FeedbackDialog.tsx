import { useEffect, useState, useSyncExternalStore } from "react";
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
const emptyEntries = () => [];
const noSubscription = () => () => {};

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
  // A relay/viewer switch must not carry a draft, error, or pending Done callback
  // into a different private inbox.
  return (
    <FeedbackForConnection
      key={connection.generation}
      open={open}
      onOpenChange={onOpenChange}
      connection={connection}
    />
  );
}

function FeedbackForConnection({
  open,
  onOpenChange,
  connection,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  connection: RelaySnapshot;
}) {
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
    try {
      await outbox.dismiss(pending.event.id);
      setMessage("");
      setCategory(null);
      setError("");
      onOpenChange(false);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not clear delivered feedback.",
      );
    } finally {
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
      onOpenChange={onOpenChange}
      title="Send feedback"
      description="Feedback goes to this Buzz deployment's private operator inbox, not a channel."
      actions={
        <>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
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
