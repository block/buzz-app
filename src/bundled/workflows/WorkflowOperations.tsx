import { useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import type {
  WorkflowCapability,
  WorkflowOperation,
} from "../../features/workflows/types";

export function WorkflowOperations({
  operations,
  capability,
}: {
  operations: readonly WorkflowOperation[];
  capability: WorkflowCapability;
}) {
  const [error, setError] = useState<string | null>(null);
  if (!operations.length) return null;
  return (
    <section aria-label="Workflow operations" className="workflow-operations">
      <h3 className="text-heading">Recent operations</h3>
      {error && <p role="alert">{error}</p>}
      {operations.map((operation) => (
        <div key={operation.eventId}>
          <p role="status">
            {operation.action}: {operation.outcome} · delivery{" "}
            {operation.delivery}
          </p>
          <p className="text-mono-sm workflow-key">{operation.eventId}</p>
          {operation.error && <p className="text-red-12">{operation.error}</p>}
          {operation.outcome === "unknown" && (
            <p className="text-body-sm text-secondary">
              The outcome is unknown. Do not submit a new operation to repeat
              it; its signed identity is retained by the host. Exact replay may
              confirm delivery but cannot recover a lost run or secret receipt.
            </p>
          )}
          {operation.outcome === "unknown" && (
            <Button
              size="compact"
              onClick={() => {
                try {
                  capability.operations.retry(operation.eventId);
                  setError(null);
                } catch (cause) {
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "Retry could not be requested.",
                  );
                }
              }}
            >
              Retry same signed operation
            </Button>
          )}
          {operation.runId && (
            <p className="text-body-sm">
              Returned run ID:{" "}
              <span className="text-mono-sm workflow-key">
                {operation.runId}
              </span>
            </p>
          )}
          {operation.secretAvailable && (
            <p className="text-body-sm">
              A one-time secret is available, but secure reveal is not supported
              by this UI yet.
            </p>
          )}
        </div>
      ))}
    </section>
  );
}
