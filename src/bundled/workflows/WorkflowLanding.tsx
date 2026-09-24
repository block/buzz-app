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

const EMPTY_DEFINITIONS: WorkflowDefinitions = Object.freeze({
  items: Object.freeze([]),
  partial: false,
});

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
  const [snapshots, setSnapshots] = useState<
    Readonly<Record<string, DefinitionsSnapshot>>
  >({});
  const channelIdsKey = channels.map((channel) => channel.id).join(":");
  const channelIds = useMemo(
    () => (channelIdsKey ? channelIdsKey.split(":") : []),
    [channelIdsKey],
  );
  const anchorChannelId = channelIds[0] ?? "";
  const { snapshot: anchorSnapshot, refresh: refreshAnchor } = useWorkflowView(
    useCallback(
      () => capability.definitions(anchorChannelId),
      [anchorChannelId, capability],
    ),
  );
  const readEpoch = useRef(0);

  useEffect(() => {
    if (
      anchorSnapshot?.status !== "idle" &&
      anchorSnapshot?.status !== "unavailable"
    )
      return;
    readEpoch.current++;
    setSnapshots({});
  }, [anchorSnapshot?.status]);

  useEffect(() => {
    void refreshRequest;
    void operationRefreshKey;
    const epoch = ++readEpoch.current;
    let cancelled = false;
    let activeView: WorkflowView<WorkflowDefinitions> | undefined;
    const remainingChannelIds = channelIds.slice(1);
    const activeIds = new Set(remainingChannelIds);
    setSnapshots((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([channelId]) =>
          activeIds.has(channelId),
        ),
      ),
    );
    void refreshAnchor();

    const read = async () => {
      for (const channelId of remainingChannelIds) {
        if (cancelled || readEpoch.current !== epoch) return;
        setSnapshots((current) =>
          current[channelId]
            ? current
            : {
                ...current,
                [channelId]: {
                  status: "loading",
                  data: EMPTY_DEFINITIONS,
                },
              },
        );
        let view: WorkflowView<WorkflowDefinitions> | undefined;
        try {
          view = capability.definitions(channelId);
          activeView = view;
          await view.refresh();
          if (cancelled || readEpoch.current !== epoch) return;
          const snapshot = view.snapshot();
          setSnapshots((current) => ({
            ...current,
            [channelId]: snapshot,
          }));
        } catch {
          if (cancelled || readEpoch.current !== epoch) return;
          setSnapshots((current) => ({
            ...current,
            [channelId]: {
              status: "error",
              data: EMPTY_DEFINITIONS,
              error:
                "Workflow read unavailable. Retry; this is not proof of deletion.",
            },
          }));
        } finally {
          view?.dispose();
          if (activeView === view) activeView = undefined;
        }
      }
    };
    void read();
    return () => {
      cancelled = true;
      readEpoch.current++;
      activeView?.dispose();
    };
  }, [
    capability,
    channelIds,
    operationRefreshKey,
    refreshAnchor,
    refreshRequest,
  ]);

  if (
    anchorSnapshot?.status === "idle" ||
    anchorSnapshot?.status === "unavailable"
  )
    return Object.fromEntries(
      channelIds.map((channelId) => [
        channelId,
        { status: anchorSnapshot.status, data: EMPTY_DEFINITIONS },
      ]),
    );
  return anchorSnapshot
    ? { ...snapshots, [anchorChannelId]: anchorSnapshot }
    : snapshots;
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
                aria-label={`Enabled in configuration: ${name}`}
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
              <span>
                {enabled ? "Configured enabled" : "Configured disabled"}
              </span>
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
  onRetry,
}: {
  capability: WorkflowCapability;
  channel: ChannelSummary;
  operations: readonly WorkflowOperation[];
  snapshot: DefinitionsSnapshot | undefined;
  viewer: string;
  onOpen: (definition: WorkflowDefinition, channel: ChannelSummary) => void;
  onRetry: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  if (!snapshot || snapshot.status === "loading") {
    return (
      <div
        className="workflow-state-card text-body-sm text-secondary"
        role="status"
      >
        Reading workflows in #{channel.name}…
      </div>
    );
  }
  if (snapshot.status === "error") {
    return (
      <div className="workflow-state-card">
        <p className="text-body-sm text-danger">
          {snapshot.error ?? `Workflows in #${channel.name} could not be read.`}
        </p>
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  if (snapshot.status === "idle" || snapshot.status === "unavailable")
    return null;

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
      {snapshot.data.items.map((definition) => {
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
      {snapshot.data.partial && (
        <div className="workflow-state-card text-body-sm text-secondary">
          #{channel.name} returned a partial workflow list.
        </div>
      )}
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
  const [retryRequest, setRetryRequest] = useState(0);
  const operationRefreshKey = operations
    .filter(
      (operation) =>
        operation.action === "save" &&
        (operation.outcome === "unknown" || operation.outcome === "succeeded"),
    )
    .map((operation) => `${operation.eventId}:${operation.outcome}`)
    .join(":");
  const snapshots = useLandingDefinitions(
    capability,
    channels,
    refreshRequest + retryRequest,
    operationRefreshKey,
  );
  return (
    <>
      <p className="text-body-sm text-secondary">
        These switches change configuration, not confirmed runtime state. Saving
        a disabled configuration does not confirm that automatic runs have
        stopped or cancel work already running.
      </p>
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
            onRetry={() => setRetryRequest((request) => request + 1)}
            operations={operations}
            snapshot={snapshots[channel.id]}
            viewer={viewer}
          />
        ))}
      </div>
    </>
  );
}
