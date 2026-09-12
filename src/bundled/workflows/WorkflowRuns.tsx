import { useMemo, useState } from "react";
import type {
  WorkflowCapability,
  WorkflowDefinition,
  WorkflowRunCursor,
  WorkflowReference,
} from "../../features/workflows/types";
import { Button } from "../../shared/design-system/ui/Button";
import { useWorkflowView } from "./useWorkflowView";

export function WorkflowRuns({
  capability,
  workflow,
}: {
  capability: WorkflowCapability;
  workflow: WorkflowDefinition;
}) {
  const [cursor, setCursor] = useState<WorkflowRunCursor | undefined>();
  if (!capability.availability.history)
    return (
      <p className="text-secondary">
        Run history is unavailable from this host.
      </p>
    );
  return (
    <RunPage
      key={cursor ? `${cursor.before}:${cursor.beforeId}` : "first"}
      capability={capability}
      workflow={workflow}
      cursor={cursor}
      onPage={setCursor}
    />
  );
}
function RunPage({
  capability,
  workflow,
  cursor,
  onPage,
}: {
  capability: WorkflowCapability;
  workflow: WorkflowReference;
  cursor: WorkflowRunCursor | undefined;
  onPage: (cursor: WorkflowRunCursor | undefined) => void;
}) {
  const view = useMemo(
    () => capability.runs(workflow, cursor),
    [capability, workflow, cursor],
  );
  const snapshot = useWorkflowView(view);
  return (
    <section aria-label="Workflow runs" className="workflow-runs">
      <div className="workflow-toolbar">
        <h3 className="text-heading">Runs</h3>
        <Button
          disabled={snapshot.status === "loading"}
          onClick={() => void view.refresh()}
        >
          Refresh runs
        </Button>
      </div>
      {snapshot.status === "loading" && <p role="status">Reading runs…</p>}
      {snapshot.status === "unavailable" && (
        <p role="status">
          Run history is unavailable. This does not mean the workflow was
          deleted.
        </p>
      )}
      {snapshot.status === "idle" && (
        <p role="status">History cleared. Refresh to read it again.</p>
      )}
      {snapshot.status === "error" && (
        <p role="alert" className="text-red-12">
          {snapshot.error ??
            "Run history could not be read. Retry with Refresh runs."}
        </p>
      )}
      {snapshot.status === "ready" && !snapshot.data.runs.length && (
        <p>No runs returned on this page.</p>
      )}
      {snapshot.data.runs.map((run) => (
        <article key={run.id} className="workflow-step">
          <p className="text-body">
            <strong>{run.status.replaceAll("_", " ")}</strong> ·{" "}
            {new Date(run.createdAt * 1000).toISOString()}
          </p>
          <p className="text-mono-sm workflow-key">{run.id}</p>
          <p className="text-body-sm text-secondary">
            Current step: {run.currentStep}
          </p>
          {(run.errorCode || run.errorMessage) && (
            <p className="text-red-12">
              {run.errorCode}: {run.errorMessage}
            </p>
          )}
          <details>
            <summary>Execution trace</summary>
            <pre className="text-mono workflow-trace">
              {JSON.stringify(run.trace, null, 2)}
            </pre>
          </details>
          <details>
            <summary>Approval history (read-only)</summary>
            <ApprovalHistory
              capability={capability}
              workflow={workflow}
              runId={run.id}
            />
          </details>
        </article>
      ))}
      <div className="workflow-toolbar">
        {cursor && (
          <Button onClick={() => onPage(undefined)}>Newest runs</Button>
        )}
        {snapshot.status === "ready" && snapshot.data.next && (
          <Button
            onClick={() => {
              if (snapshot.data.next) onPage(snapshot.data.next);
            }}
          >
            Older runs
          </Button>
        )}
      </div>
    </section>
  );
}
function ApprovalHistory({
  capability,
  workflow,
  runId,
}: {
  capability: WorkflowCapability;
  workflow: WorkflowReference;
  runId: string;
}) {
  const [opened, setOpened] = useState(false);
  return opened ? (
    <ApprovalRows capability={capability} workflow={workflow} runId={runId} />
  ) : (
    <Button size="compact" onClick={() => setOpened(true)}>
      Read approvals
    </Button>
  );
}
function ApprovalRows({
  capability,
  workflow,
  runId,
}: {
  capability: WorkflowCapability;
  workflow: WorkflowReference;
  runId: string;
}) {
  const view = useMemo(
    () => capability.approvals(workflow, runId),
    [capability, workflow, runId],
  );
  const snapshot = useWorkflowView(view);
  return (
    <div>
      {snapshot.status === "ready" ? (
        snapshot.data.length ? (
          <ul>
            {snapshot.data.map((row) => (
              <li key={row.reference}>
                {row.stepId}: {row.status}
                {row.note ? ` — ${row.note}` : ""}
              </li>
            ))}
          </ul>
        ) : (
          <p>No approval history returned.</p>
        )
      ) : (
        <p role="status">
          {snapshot.error ?? `Approval history: ${snapshot.status}.`}
        </p>
      )}
      <Button
        size="compact"
        disabled={snapshot.status === "loading"}
        onClick={() => void view.refresh()}
      >
        Refresh approvals
      </Button>
    </div>
  );
}
