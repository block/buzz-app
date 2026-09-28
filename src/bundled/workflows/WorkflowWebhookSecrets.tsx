import { useEffect, useState, useSyncExternalStore } from "react";
import type { WorkflowCapability } from "../../features/workflows/types";
import { WorkflowWebhookSecretDialog } from "./WorkflowWebhookSecretDialog";

/** Community-scoped delivery survives navigation; values remain in the dialog. */
export function WorkflowWebhookSecrets({
  capability,
}: {
  capability: WorkflowCapability;
}) {
  const operations = useSyncExternalStore(
    capability.operations.subscribe,
    capability.operations.snapshot,
    capability.operations.snapshot,
  );
  const [eventId, setEventId] = useState<string>();
  const active = operations.find(
    (operation) =>
      operation.eventId === eventId && operation.outcome === "succeeded",
  );
  useEffect(() => {
    if (active) return;
    setEventId(
      operations.find(
        (operation) =>
          operation.action === "save" &&
          operation.outcome === "succeeded" &&
          operation.secretHeld,
      )?.eventId,
    );
  }, [active, operations]);
  useEffect(() => {
    if (!active) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);
  // Taking clears only secretHeld. Clear/revoke/dispose withdraws the successful
  // operation itself, immediately unmounting and purging any displayed value.
  return active ? (
    <WorkflowWebhookSecretDialog
      key={active.eventId}
      workflowId={active.workflow.id}
      hookUrl={capability.webhookUrl(active.workflow.id)}
      take={() => capability.takeWebhookSecret(active.eventId)}
      onContinue={() => setEventId(undefined)}
    />
  ) : null;
}
