import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type {
  WorkflowCapability,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowReference,
} from "../../features/workflows/types";
import {
  formatFullTimestamp,
  formatItemTimestamp,
} from "../../shared/datetime";
import { useClockFormat } from "../../shared/clock-preference";
import { Button } from "../../shared/design-system/ui/Button";
import { useWorkflowView } from "./useWorkflowView";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { useWorkflowRunList } from "./useWorkflowRunList";

export function WorkflowRuns({
  capability,
  workflow,
  heading = true,
}: {
  capability: WorkflowCapability;
  workflow: WorkflowDefinition;
  heading?: boolean;
}) {
  if (!capability.availability.history)
    return (
      <p className="text-secondary">
        Run history is unavailable from this host.
      </p>
    );
  return (
    <RunList capability={capability} workflow={workflow} heading={heading} />
  );
}
/** One list, newest first, that keeps itself current while it is on screen. */
function RunList({
  capability,
  workflow,
  heading,
}: {
  capability: WorkflowCapability;
  workflow: WorkflowReference;
  heading: boolean;
}) {
  useClockFormat();
  const { snapshot, refresh } = useWorkflowView(
    useCallback(() => capability.runs(workflow), [capability, workflow]),
  );
  const list = useWorkflowRunList({
    capability,
    workflow,
    newest: snapshot,
    refresh,
  });
  const [refreshing, setRefreshing] = useState(false);
  // A control that leaves while it has focus hands it to the end of the list
  // when that is marked, and to the list otherwise: never to the document.
  const oldest = useRef<HTMLParagraphElement>(null);
  const left = useRef(false);
  const handsFocus = useCallback((node: HTMLButtonElement | null) => {
    if (!node) return;
    return () => {
      if (document.activeElement === node) left.current = true;
    };
  }, []);
  useLayoutEffect(() => {
    if (!left.current) return;
    left.current = false;
    (oldest.current ?? list.region)?.focus();
  });
  // A view replaced for the same workflow keeps the runs it had read.
  if (!snapshot && !list.loaded && !list.denied)
    return <p role="status">Reading runs…</p>;
  const status = snapshot?.status;
  // A failure lasts until a read succeeds, so its line and its retry stay put
  // while the list tries again by itself.
  const needsRefresh =
    status === "idle" || list.failed || list.denied || refreshing;
  return (
    <section
      ref={list.section}
      tabIndex={-1}
      aria-label="Workflow runs"
      className="workflow-runs"
    >
      {(heading || needsRefresh) && (
        <div className="workflow-toolbar">
          {heading && <h3 className="text-heading">Runs</h3>}
          {/* The list rereads itself; only these states wait for a person. */}
          {needsRefresh && (
            <Button
              ref={handsFocus}
              loading={refreshing}
              onClick={() => {
                setRefreshing(true);
                void list.refresh().finally(() => setRefreshing(false));
              }}
            >
              Refresh runs
            </Button>
          )}
        </div>
      )}
      {status === "loading" && !list.loaded && !list.failed && !list.denied && (
        <p role="status">Reading runs…</p>
      )}
      {status === "unavailable" && (
        <p role="status">
          Run history is unavailable. This does not mean the workflow was
          deleted.
        </p>
      )}
      {status === "idle" && (
        <p role="status">History cleared. Refresh to read it again.</p>
      )}
      {list.denied && (
        <p role="alert" className="text-danger">
          The relay refused to show this workflow’s runs, so the ones shown here
          were removed. Retry with Refresh runs.
        </p>
      )}
      {list.failed && (
        <p role="alert" className="text-danger">
          {list.error ??
            "Run history could not be read. Retry with Refresh runs."}
        </p>
      )}
      {list.loaded && !list.failed && !list.runs.length && <p>No runs yet.</p>}
      {list.runs.map((run) => (
        <article key={run.id} className="workflow-step">
          <p className="text-body">
            <strong>{RUN_STATUS_LABELS[run.status]}</strong> ·{" "}
            <time
              dateTime={new Date(run.createdAt * 1000).toISOString()}
              title={formatFullTimestamp(run.createdAt)}
            >
              {formatItemTimestamp(run.createdAt, { withTime: true })}
            </time>
          </p>
          {run.status === "waiting_approval" ? (
            <p className="text-body text-secondary">
              Current step: {run.currentStep + 1}
            </p>
          ) : run.status === "failed" && run.startedAt !== null ? (
            // A run that failed without starting never reached a step.
            <p className="text-body text-secondary">
              Step {run.currentStep + 1}
            </p>
          ) : null}
          {(run.errorCode || run.errorMessage) && (
            <p className="text-danger">
              {run.errorCode}: {run.errorMessage}
            </p>
          )}
          <details>
            <summary>Run details and trace</summary>
            <p className="text-mono-sm workflow-key">Run ID: {run.id}</p>
            <pre className="text-mono workflow-trace">
              {JSON.stringify(run.trace, null, 2)}
            </pre>
          </details>
        </article>
      ))}
      {/* Like LoadingRegion's line: mounted throughout, a status only when it
          has something to say. */}
      <p className="sr-only" role={list.added ? "status" : undefined}>
        {list.added
          ? `${list.added} older ${list.added === 1 ? "run" : "runs"} loaded.`
          : ""}
      </p>
      {list.more ? (
        // Reaching this loads the next page; the button is the same action
        // for a keyboard or screen reader, and stays put while a page is read.
        <div ref={list.end}>
          <LoadingRegion
            pending={list.older === "loading"}
            label="Reading older runs…"
            feedback={
              list.older === "failed" ? (
                <p role="alert" className="text-danger">
                  Older runs could not be read. Retry with Load older runs.
                </p>
              ) : undefined
            }
          >
            <Button ref={handsFocus} onClick={() => void list.loadOlder()}>
              Load older runs
            </Button>
          </LoadingRegion>
        </div>
      ) : (
        list.ended && (
          <p
            ref={oldest}
            tabIndex={-1}
            className="workflow-runs-end text-body text-secondary"
          >
            No older runs.
          </p>
        )
      )}
    </section>
  );
}

const RUN_STATUS_LABELS: Record<WorkflowRun["status"], string> = {
  pending: "Pending",
  running: "Running",
  waiting_approval: "Waiting for approval",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};
