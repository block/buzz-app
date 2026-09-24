import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type {
  WorkflowCapability,
  WorkflowDefinition,
  WorkflowDefinitions,
  WorkflowOperation,
  WorkflowView,
} from "../../features/workflows/types";
import {
  ArrowRightIcon,
  CalendarIcon,
  ChatCircleIcon,
  GitPullRequestIcon,
  LightningIcon,
  PlusIcon,
  SmileyIcon,
  TimerIcon,
  WebhooksLogoIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Switch } from "../../shared/design-system/ui/Switch";
import { ConfirmAction } from "./ConfirmAction";
import { getWorkflowActivationWarning } from "./workflowActivationWarning";
import {
  workflowCardPresentation,
  type WorkflowCardIcon,
} from "./workflowCardPresentation";
import {
  readWorkflowDocumentFields,
  yamlWithWorkflowEnabled,
} from "./workflowYamlDocument";
import { useWorkflowView } from "./useWorkflowView";

const ICONS: Record<WorkflowCardIcon, typeof LightningIcon> = {
  delay: TimerIcon,
  diff: GitPullRequestIcon,
  message: ChatCircleIcon,
  reaction: SmileyIcon,
  schedule: CalendarIcon,
  webhook: WebhooksLogoIcon,
  workflow: LightningIcon,
};

type DefinitionsSnapshot = ReturnType<
  WorkflowView<WorkflowDefinitions>["snapshot"]
>;

function workflowOperationLocked(
  operations: readonly WorkflowOperation[],
  definition: WorkflowDefinition,
) {
  const matches = (operation: WorkflowOperation) =>
    operation.workflow.channelId === definition.channelId &&
    operation.workflow.id === definition.id &&
    operation.workflow.owner === definition.owner;
  if (
    operations.some(
      (operation) =>
        operation.action === "delete" &&
        operation.outcome !== "rejected" &&
        matches(operation),
    )
  )
    return true;
  for (let index = operations.length - 1; index >= 0; index--) {
    const operation = operations[index];
    if (!operation) continue;
    if (!matches(operation) || operation.outcome === "rejected") continue;
    if (operation.outcome === "pending" || operation.outcome === "unknown")
      return true;
    if (operation.action === "save")
      return operation.eventId !== definition.revision;
  }
  return false;
}

function useLandingDefinitions(
  capability: WorkflowCapability,
  channels: readonly ChannelSummary[],
  refreshRequest: number,
  operationRefreshKey: string,
) {
  const channelIdsKey = channels
    .map((channel) => channel.id)
    .sort()
    .join(":");
  const channelIds = useMemo(
    () => (channelIdsKey ? channelIdsKey.split(":") : []),
    [channelIdsKey],
  );
  const view = useWorkflowView(
    useCallback(
      () => capability.definitions(channelIds),
      [channelIds, capability],
    ),
  );
  const refreshKey = `${refreshRequest}:${operationRefreshKey}`;
  const previousRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (previousRefreshKey.current === refreshKey) return;
    previousRefreshKey.current = refreshKey;
    void view.refresh();
  }, [refreshKey, view.refresh]);
  return view;
}

function WorkflowIcon({ kind }: { kind: WorkflowCardIcon }) {
  const Icon = ICONS[kind];
  return <Icon size={20} weight="bold" aria-hidden="true" />;
}

function WorkflowCard({
  capability,
  channel,
  definition,
  locked,
  operations,
  viewer,
  onError,
  onOpen,
}: {
  capability: WorkflowCapability;
  channel: ChannelSummary;
  definition: WorkflowDefinition;
  locked: boolean;
  operations: readonly WorkflowOperation[];
  viewer: string;
  onError: (message: string | null) => void;
  onOpen: (definition: WorkflowDefinition, channel: ChannelSummary) => void;
}) {
  const [confirmEnable, setConfirmEnable] = useState(false);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const fields = readWorkflowDocumentFields(definition.yaml);
  const presentation = workflowCardPresentation(definition.yaml);
  const enabled = fields.enabled !== false;
  const readonly = definition.owner !== viewer;
  const submittedOperation = operations.find(
    (operation) => operation.eventId === submitted,
  );
  const awaitingReadback =
    submitted !== null &&
    definition.revision !== submitted &&
    submittedOperation?.outcome !== "rejected";
  const toggleDisabled =
    readonly ||
    locked ||
    awaitingReadback ||
    !fields.editable ||
    !capability.availability.save;
  const warning = getWorkflowActivationWarning(definition.yaml);
  const name = fields.name || "Unnamed or malformed workflow";
  const toggle = (next: boolean) => {
    const yaml = yamlWithWorkflowEnabled(definition.yaml, next);
    if (yaml === null) {
      onError("This workflow cannot be changed from the landing page.");
      return;
    }
    try {
      const operationId = capability.save({
        channelId: channel.id,
        existing: definition,
        yaml,
      });
      setSubmitted(operationId);
      onError(null);
    } catch (cause) {
      onError(
        cause instanceof Error
          ? cause.message
          : "The workflow status could not be submitted.",
      );
    }
  };

  return (
    <>
      <article className="workflow-card">
        <Button
          aria-label={`Open ${name}`}
          data-workflow-card-open=""
          onClick={() => onOpen(definition, channel)}
          variant="ghost"
        >
          Open {name}
        </Button>
        <div className="workflow-card-content">
          <div className="workflow-card-topline">
            <div className="workflow-card-flow" aria-hidden="true">
              <span className="workflow-card-icon">
                {presentation.triggerEmoji ? (
                  <span className="workflow-card-emoji text-body-lg">
                    {presentation.triggerEmoji}
                  </span>
                ) : (
                  <WorkflowIcon kind={presentation.triggerIcon} />
                )}
              </span>
              {presentation.actionIcons.length > 0 && (
                <>
                  <ArrowRightIcon
                    className="workflow-card-arrow"
                    size={16}
                    aria-hidden="true"
                  />
                  <span className="workflow-card-action-stack">
                    {presentation.actionIcons
                      .slice(0, 3)
                      .map((action, index) => (
                        <span
                          className="workflow-card-icon workflow-card-action"
                          data-index={index}
                          key={action.key}
                        >
                          <WorkflowIcon kind={action.icon} />
                        </span>
                      ))}
                  </span>
                </>
              )}
            </div>
            <div className="workflow-card-switch">
              <Switch
                aria-label={enabled ? `Disable ${name}` : `Enable ${name}`}
                checked={enabled}
                disabled={toggleDisabled}
                onCheckedChange={(next) => {
                  if (next === enabled) return;
                  if (next && warning) setConfirmEnable(true);
                  else toggle(next);
                }}
              />
            </div>
          </div>
          <h2 className="workflow-card-description text-body-lg">
            {presentation.description}
          </h2>
          <div className="workflow-card-meta text-caption text-secondary">
            <div className="workflow-card-identity">
              <strong className="text-standard">#{channel.name}</strong>
              <span>{name}</span>
              {readonly && <span>Read-only</span>}
            </div>
            <time
              dateTime={new Date(definition.createdAt * 1000).toISOString()}
            >
              {new Date(definition.createdAt * 1000).toLocaleDateString()}
            </time>
          </div>
        </div>
      </article>
      {confirmEnable && (
        <ConfirmAction
          title={warning?.title ?? "Turn on this workflow?"}
          description={
            warning?.description ??
            "The relay may run this workflow as soon as its trigger matches."
          }
          action="Turn on"
          cancel="Keep off"
          onCancel={() => setConfirmEnable(false)}
          onConfirm={() => {
            setConfirmEnable(false);
            toggle(true);
          }}
        />
      )}
    </>
  );
}

function WorkflowChannelCards({
  capability,
  channel,
  operations,
  snapshot,
  viewer,
  onOpen,
}: {
  capability: WorkflowCapability;
  channel: ChannelSummary;
  operations: readonly WorkflowOperation[];
  snapshot: DefinitionsSnapshot | undefined;
  viewer: string;
  onOpen: (definition: WorkflowDefinition, channel: ChannelSummary) => void;
}) {
  const [error, setError] = useState<string | null>(null);

  if (!snapshot) return null;

  return (
    <>
      {error && (
        <div className="workflow-state-card" role="alert">
          <p className="text-body-sm text-danger">{error}</p>
          <Button size="sm" onClick={() => setError(null)}>
            Dismiss
          </Button>
        </div>
      )}
      {snapshot.data.items
        .filter((definition) => definition.channelId === channel.id)
        .map((definition) => {
          return (
            <WorkflowCard
              capability={capability}
              channel={channel}
              definition={definition}
              key={`${definition.owner}:${definition.id}:${definition.revision}`}
              locked={workflowOperationLocked(operations, definition)}
              onError={setError}
              onOpen={onOpen}
              operations={operations}
              viewer={viewer}
            />
          );
        })}
    </>
  );
}

export function WorkflowLanding({
  capability,
  channels,
  refreshRequest,
  viewer,
  onCreate,
  onOpen,
}: {
  capability: WorkflowCapability;
  channels: readonly ChannelSummary[];
  refreshRequest: number;
  viewer: string;
  onCreate: () => void;
  onOpen: (definition: WorkflowDefinition, channel: ChannelSummary) => void;
}) {
  const operations = useSyncExternalStore(
    capability.operations.subscribe,
    capability.operations.snapshot,
    capability.operations.snapshot,
  );
  const operationRefreshKey = operations
    .filter(
      (operation) =>
        operation.action === "save" &&
        (operation.outcome === "unknown" || operation.outcome === "succeeded"),
    )
    .map((operation) => `${operation.eventId}:${operation.outcome}`)
    .join(":");
  const { snapshot, refresh } = useLandingDefinitions(
    capability,
    channels,
    refreshRequest,
    operationRefreshKey,
  );
  if (
    !snapshot ||
    (snapshot.status === "loading" && !snapshot.data.items.length)
  )
    return (
      <div
        className="workflow-card-grid"
        role="status"
        aria-label="Loading workflows"
      >
        {[0, 1, 2, 3].map((index) => (
          <div
            key={index}
            className="workflow-state-card workflow-skeleton"
            aria-hidden="true"
          />
        ))}
      </div>
    );
  if (
    snapshot.status === "error" ||
    snapshot.status === "idle" ||
    snapshot.status === "unavailable"
  )
    return (
      <div className="workflow-page-state">
        <p role={snapshot.status === "error" ? "alert" : "status"}>
          {snapshot.error ??
            (snapshot.status === "unavailable"
              ? "Workflow access unavailable."
              : "Refresh to load workflows.")}
        </p>
        {snapshot.status !== "unavailable" && (
          <Button onClick={() => void refresh()}>Retry</Button>
        )}
      </div>
    );
  return (
    <>
      {snapshot.data.partial && (
        <p className="text-secondary">The workflow list is partial.</p>
      )}
      <div className="workflow-card-grid">
        <Button
          aria-label="New workflow"
          data-workflow-create-card=""
          disabled={!capability.availability.save || channels.length === 0}
          onClick={onCreate}
          variant="ghost"
        >
          <PlusIcon size={28} weight="bold" aria-hidden="true" />
        </Button>
        {channels.map((channel) => (
          <WorkflowChannelCards
            capability={capability}
            channel={channel}
            key={channel.id}
            onOpen={onOpen}
            operations={operations}
            snapshot={snapshot}
            viewer={viewer}
          />
        ))}
      </div>
    </>
  );
}
