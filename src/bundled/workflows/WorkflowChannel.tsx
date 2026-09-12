import {
  useEffect,
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  WorkflowCapability,
  WorkflowDefinition,
} from "../../features/workflows/types";
import { Button } from "../../shared/design-system/ui/Button";
import { ConfirmAction } from "./ConfirmAction";
import { WorkflowEditor } from "./WorkflowEditor";
import { WorkflowOperations } from "./WorkflowOperations";
import { WorkflowRuns } from "./WorkflowRuns";
import { exactSaveReadback } from "./editor-model";
import { DEFAULT_FORM_STATE, formStateToYaml } from "./workflowFormTypes";
import { readWorkflowDocumentFields } from "./workflowYamlDocument";
import { useWorkflowView } from "./useWorkflowView";

type Draft = {
  original: WorkflowDefinition | undefined;
  yaml: string;
  initial: string;
  operationId?: string;
};

export function WorkflowChannel({
  capability,
  channelId,
  channelName,
  viewer,
  onDraftRiskChange,
}: {
  capability: WorkflowCapability;
  channelId: string;
  channelName: string;
  viewer: string;
  onDraftRiskChange?: (atRisk: boolean) => void;
}) {
  const { snapshot, refresh } = useWorkflowView(
    useCallback(
      () => capability.definitions(channelId),
      [capability, channelId],
    ),
  );
  const operations = useSyncExternalStore(
    capability.operations.subscribe,
    capability.operations.snapshot,
    capability.operations.snapshot,
  );
  const submission = useRef<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pendingSelection, setPendingSelection] = useState<
    WorkflowDefinition | "new" | "close" | null
  >(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readRuns, setReadRuns] = useState(false);
  const operation = draft?.operationId
    ? operations.find((item) => item.eventId === draft.operationId)
    : undefined;
  const ownOperations = operations.filter(
    (item) => item.workflow.channelId === channelId,
  );
  const busy =
    !!draft?.operationId && (!operation || operation.outcome === "pending");
  const readonly = !!draft?.original && draft.original.owner !== viewer;
  const dirty = !!draft && draft.yaml !== draft.initial;
  const atRisk = dirty || !!draft?.operationId;
  const unresolvedWrite = ownOperations.some(
    (item) =>
      (item.outcome === "pending" || item.outcome === "unknown") &&
      (draft?.original
        ? item.workflow.id === draft.original.id &&
          item.workflow.owner === draft.original.owner
        : item.action === "save"),
  );
  useEffect(() => {
    onDraftRiskChange?.(atRisk);
    return () => onDraftRiskChange?.(false);
  }, [atRisk, onDraftRiskChange]);
  useEffect(() => {
    if (!atRisk) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [atRisk]);
  const open = (next: WorkflowDefinition | "new" | "close") => {
    const yaml =
      next === "new"
        ? formStateToYaml({ ...DEFAULT_FORM_STATE, name: "Untitled workflow" })
        : next === "close"
          ? ""
          : next.yaml;
    setDraft(
      next === "close"
        ? null
        : {
            original: typeof next === "string" ? undefined : next,
            yaml,
            initial: yaml,
          },
    );
    submission.current = null;
    setError(null);
    setReadRuns(false);
    setPendingSelection(null);
    setConfirmDelete(false);
  };
  const select = (next: WorkflowDefinition | "new" | "close") => {
    if (atRisk) setPendingSelection(next);
    else open(next);
  };
  useEffect(() => {
    if (operation?.eventId && operation.outcome === "succeeded") void refresh();
  }, [operation?.eventId, operation?.outcome, refresh]);
  useEffect(() => {
    if (!operation || !draft || snapshot?.status !== "ready") return;
    const saved = exactSaveReadback(operation, snapshot.data.items);
    if (saved) {
      submission.current = null;
      setDraft({ original: saved, yaml: saved.yaml, initial: saved.yaml });
    }
  }, [operation, snapshot, draft]);
  // A cleared/unavailable view withdraws the saved private definition from display.
  // Unsaved user-authored drafts never become a second retained definition cache.
  useEffect(() => {
    if (snapshot?.status === "unavailable" || snapshot?.status === "idle") {
      submission.current = null;
      setDraft(null);
      setPendingSelection(null);
      setConfirmDelete(false);
      setReadRuns(false);
      setError(null);
    }
  }, [snapshot?.status]);
  const save = () => {
    if (
      !draft ||
      submission.current ||
      busy ||
      unresolvedWrite ||
      readonly ||
      !capability.availability.save ||
      draft.operationId
    )
      return;
    try {
      submission.current = "submitting";
      const operationId = capability.save({
        channelId,
        yaml: draft.yaml,
        ...(draft.original ? { existing: draft.original } : {}),
      });
      submission.current = operationId;
      setDraft({ ...draft, operationId });
      setError(null);
    } catch (cause) {
      submission.current = null;
      setError(
        cause instanceof Error
          ? cause.message
          : "The workflow could not be submitted. Your draft is retained.",
      );
    }
  };
  const remove = () => {
    if (
      !draft?.original ||
      submission.current ||
      readonly ||
      unresolvedWrite ||
      !capability.availability.delete ||
      draft.operationId
    )
      return;
    try {
      submission.current = "submitting";
      const operationId = capability.delete(draft.original);
      submission.current = operationId;
      setDraft({ ...draft, operationId });
      setConfirmDelete(false);
      setError(null);
    } catch (cause) {
      submission.current = null;
      setError(
        cause instanceof Error
          ? cause.message
          : "Deletion could not be submitted. Your draft is retained.",
      );
    }
  };
  const trigger = () => {
    if (
      !draft?.original ||
      submission.current ||
      dirty ||
      unresolvedWrite ||
      draft.operationId ||
      readonly ||
      !capability.availability.trigger
    )
      return;
    try {
      submission.current = "submitting";
      submission.current = capability.trigger(draft.original);
      setError(null);
    } catch (cause) {
      submission.current = null;
      setError(
        cause instanceof Error ? cause.message : "Run could not be submitted.",
      );
    }
  };
  useEffect(() => {
    const active = operations.find(
      (item) => item.eventId === submission.current,
    );
    if (
      active?.action === "trigger" &&
      (active.outcome === "succeeded" || active.outcome === "rejected")
    )
      submission.current = null;
  }, [operations]);
  let blocked: string | undefined;
  if (!capability.availability.save)
    blocked = "Saving is unavailable from this host.";
  else if (unresolvedWrite && !draft?.operationId)
    blocked =
      "An operation for this workflow is unresolved. Review its retained identity below; do not submit a replacement.";
  else if (draft?.operationId)
    blocked =
      operation?.outcome === "succeeded"
        ? operation.action === "delete"
          ? "Deletion completed. Close this draft; the configuration list is being refreshed."
          : "Save completed; waiting for a readback of this exact signed revision. A different head must be reviewed before editing again."
        : operation?.outcome === "rejected"
          ? "Save rejected. Your draft is retained; review the error before retrying."
          : "This operation has not been resolved. Your draft and operation identity are retained.";
  if (!snapshot) return <p role="status">Reading configurations…</p>;
  return (
    <section aria-label={`Workflows in ${channelName}`}>
      <div className="workflow-toolbar">
        <h2 className="text-heading">Saved configurations</h2>
        <Button
          disabled={snapshot.status === "loading"}
          onClick={() => void refresh()}
        >
          Refresh configurations
        </Button>
        <Button
          disabled={
            !capability.availability.save ||
            snapshot.status === "unavailable" ||
            snapshot.status === "idle"
          }
          onClick={() => select("new")}
        >
          New workflow
        </Button>
      </div>
      <p className="text-body-sm text-secondary">
        Configured state is not runtime health. Historical configurations may no
        longer have a runtime workflow.
      </p>
      {snapshot.status === "loading" && (
        <p role="status">Reading configurations…</p>
      )}
      {snapshot.status === "idle" && (
        <p role="status">Configurations cleared. Refresh to read again.</p>
      )}
      {snapshot.status === "unavailable" && (
        <p role="status">Workflow definitions are unavailable.</p>
      )}
      {snapshot.status === "error" && (
        <p role="alert" className="text-red-12">
          {snapshot.error ??
            "Configurations could not be read. Use Refresh configurations to retry."}
        </p>
      )}
      {snapshot.data.partial && (
        <p className="text-secondary">This is a bounded, partial list.</p>
      )}
      {snapshot.status === "ready" && !snapshot.data.items.length && (
        <p>
          No saved configurations returned for this channel. Create a disabled
          draft to start.
        </p>
      )}
      <ul className="workflow-list">
        {snapshot.data.items.map((definition) => {
          const header = readWorkflowDocumentFields(definition.yaml);
          return (
            <li key={`${definition.owner}:${definition.id}`}>
              <Button variant="ghost" onClick={() => select(definition)}>
                {header.name || "Unnamed or malformed workflow"}
              </Button>
              <span className="text-body-sm text-secondary">
                {header.editable
                  ? header.enabled === false
                    ? "Configured disabled"
                    : "Configured enabled"
                  : "Unreadable configuration"}
                {definition.owner !== viewer ? " · Read-only" : ""}
              </span>
            </li>
          );
        })}
      </ul>
      {draft &&
        snapshot.status !== "unavailable" &&
        snapshot.status !== "idle" && (
          <div className="workflow-detail">
            <div className="workflow-toolbar">
              <h2 className="text-heading">
                {draft.original ? "Workflow details" : "New workflow"}
              </h2>
              <Button onClick={() => select("close")}>Close editor</Button>
            </div>
            {draft.original && (
              <>
                <p className="text-mono-sm workflow-key">
                  Owner: {draft.original.owner}
                </p>
                <p className="text-mono-sm workflow-key">
                  Revision: {draft.original.revision}
                </p>
              </>
            )}
            {readonly && (
              <p className="text-secondary">
                This definition belongs to another identity. Only its author can
                manage it here.
              </p>
            )}
            <WorkflowEditor
              key={draft.original?.revision ?? "new"}
              yaml={draft.yaml}
              onChange={(yaml) => setDraft({ ...draft, yaml })}
              onSave={save}
              readOnly={readonly}
              busy={busy}
              locked={!!draft.operationId}
              blocked={blocked}
            />
            <p className="text-body-sm text-secondary">
              Drafts stay in this editor only. Leaving the Workflows page or
              reloading discards unsaved text, but does not cancel submitted
              operations.
            </p>
            {error && (
              <p role="alert" className="text-red-12">
                {error}
              </p>
            )}
            {operation?.outcome === "rejected" && (
              <Button
                onClick={() => {
                  submission.current = null;
                  const { operationId: _, ...rest } = draft;
                  setDraft(rest);
                }}
              >
                Continue editing retained draft
              </Button>
            )}
            {draft.original && (
              <div className="workflow-toolbar">
                <Button
                  disabled={!capability.availability.history}
                  onClick={() => setReadRuns((value) => !value)}
                >
                  {readRuns ? "Hide runs" : "Read runs"}
                </Button>
                {!readonly && (
                  <>
                    <Button
                      disabled={
                        dirty ||
                        !!draft.operationId ||
                        unresolvedWrite ||
                        !capability.availability.trigger
                      }
                      onClick={trigger}
                    >
                      Run now
                    </Button>
                    <Button
                      disabled={
                        !!draft.operationId ||
                        unresolvedWrite ||
                        !capability.availability.delete
                      }
                      onClick={() => setConfirmDelete(true)}
                    >
                      Delete workflow
                    </Button>
                  </>
                )}
              </div>
            )}
            {draft.original && !capability.availability.delete && !readonly && (
              <p className="text-body-sm text-secondary">
                Delete is unavailable until the relay proves support for
                consistent workflow deletion.
              </p>
            )}
            {draft.original && readRuns && (
              <WorkflowRuns
                key={`${draft.original.owner}:${draft.original.id}`}
                capability={capability}
                workflow={draft.original}
              />
            )}
            {confirmDelete && (
              <ConfirmAction
                title="Delete this workflow?"
                description="This removes the runtime workflow and its run history. Deletion is not complete until the host reports a verified outcome."
                action="Delete workflow"
                onConfirm={remove}
                onCancel={() => setConfirmDelete(false)}
              />
            )}
          </div>
        )}
      <WorkflowOperations capability={capability} operations={ownOperations} />
      {pendingSelection &&
        snapshot.status !== "idle" &&
        snapshot.status !== "unavailable" && (
          <ConfirmAction
            title="Leave this draft?"
            description="Unsaved draft changes will be discarded. Any submitted operation stays with the captured community session; leaving does not cancel or repeat it."
            action="Leave draft"
            onConfirm={() => open(pendingSelection)}
            onCancel={() => setPendingSelection(null)}
          />
        )}
    </section>
  );
}
