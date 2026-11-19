import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useWorkflowAgentMentions } from "./useWorkflowAgentMentions";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { WorkflowDefinition } from "../../features/workflows/types";
import { workflowRoute } from "../../features/workflows/route";
import type { Navigation } from "../../features/navigation/controller";
import type { PageNavigation } from "../../features/navigation/service";
import { targetKey, type OpenTarget } from "../../features/navigation/targets";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import { relayPartition } from "../../features/relay/partition";
import {
  ArrowsClockwiseIcon,
  LightningIcon,
  PlusIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { WorkflowEditor } from "./WorkflowEditor";
import { DEFAULT_FORM_STATE, formStateToYaml } from "./workflowFormTypes";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Panel } from "../../shared/design-system/ui/Panel";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { WorkflowChannelPicker } from "./WorkflowChannelPicker";
import { WorkflowChannel } from "./WorkflowChannel";
import {
  useWorkflowMentionMembers,
  WorkflowMentionMembers,
} from "./WorkflowMessageText";
import { WorkflowWebhookSecrets } from "./WorkflowWebhookSecrets";
import {
  WorkflowLanding,
  workflowOperationLocked,
  WORKFLOW_NOT_FOUND,
} from "./WorkflowLanding";
import { PanelWorkspace } from "../../features/panels/PanelWorkspace";
import { usePanelSplit } from "../../features/panels/usePanelSplit";
import "./workflows.css";

type WorkflowsNavigation = {
  /** This visit; its route may name one workflow to open. */
  navigation?: PageNavigation | undefined;
  navigator?: Navigation | undefined;
};
/** The visit whose workflow opened or was not found, kept by the page: the
 * community below is rebuilt on every reconnect and must not open that
 * workflow, or report it missing, again. */
type AnsweredRoute = {
  revealed?: string | undefined;
  onRevealed?: ((entryId: string) => void) | undefined;
};
const withoutRoute = (target: Extract<OpenTarget, { kind: "page" }>) => {
  const { route: _route, ...page } = target;
  return page;
};

export function WorkflowsPage({
  relay,
  navigation,
  navigator,
}: { relay: RelayData } & WorkflowsNavigation) {
  const connection = useRelayConnection(relay);
  const [revealed, setRevealed] = useState<string>();
  return connection.status === "ready" ? (
    <WorkflowCommunity
      key={`${connection.scope}:${connection.generation}`}
      session={connection.session}
      viewer={connection.viewer ?? ""}
      navigation={navigation}
      navigator={navigator}
      revealed={revealed}
      onRevealed={setRevealed}
    />
  ) : (
    <WorkflowsPanel>
      <WorkflowPageHeader />
      <div className="workflow-page-state">
        <p>
          {connection.status === "connecting"
            ? "Connecting to your community…"
            : "Connect to a community to browse workflows."}
        </p>
        {connection.status === "error" && (
          <>
            <p role="alert">{connection.error}</p>
            <Button onClick={() => relay.tryAgain()}>Retry connection</Button>
          </>
        )}
      </div>
    </WorkflowsPanel>
  );
}

function WorkflowsPanel({ children }: { children: ReactNode }) {
  return (
    <Panel aria-label="Workflows">
      <div className="workflows-page text-body">{children}</div>
    </Panel>
  );
}
export function WorkflowCommunity({
  session,
  viewer,
  navigation,
  navigator,
  revealed,
  onRevealed,
}: {
  session: RelaySession;
  viewer: string;
} & WorkflowsNavigation &
  AnsweredRoute) {
  const capability = session.workflows;
  const channels = useChannelList(session.channels);
  // A channel restored from the saved list is not read until the roster
  // confirms it: the session refuses its workflow reads, and one refusal
  // clears the landing with nothing to start it again.
  const eligible = channels.channels.filter(
    (item) => !item.huddle && !item.metadataPending && !item.cached,
  );
  // More channels can become eligible while the list is still being read, or
  // one awaits its roster or the metadata that classifies it.
  const settled =
    channels.status === "ready" &&
    !channels.channels.some(
      (item) => !item.huddle && (item.metadataPending || item.cached),
    );
  // Archived channels stay eligible, so their workflows can still be found,
  // turned off and deleted, and an open editor keeps its draft.
  const creatable = eligible.filter((item) => !item.archived);
  const [selected, setSelected] = useState("");
  const [selectedDefinition, setSelectedDefinition] = useState<
    WorkflowDefinition | "new" | undefined
  >();
  const [refreshRequest, setRefreshRequest] = useState(0);
  const [saveReadback, setSaveReadback] =
    useState<Pick<WorkflowDefinition, "channelId" | "revision">>();
  const deleting = useRef(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [filter, setFilter] = useState<readonly string[]>([]);
  const split = usePanelSplit(session.scope, "workflows", 448, 320);
  const [detail, setDetail] = useState<{ key: string; name: string }>();
  const [detailTarget, setDetailTarget] = useState<HTMLElement | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  // A visit opened at one workflow, as from a message it sent. The address
  // applies only in the community it was opened for, and grants nothing: the
  // landing selects the workflow only among the definitions it could read.
  const target = navigation?.target.kind === "page" ? navigation.target : null;
  const route = workflowRoute(target?.route?.params);
  const entryId = navigation?.entryId;
  const inScope =
    !target?.scope ||
    relayPartition(target.scope.communityOrigin, target.scope.viewer) ===
      session.scope;
  const reveal = useMemo(
    () =>
      entryId && inScope && route?.owner && route.id
        ? { entryId, owner: route.owner, id: route.id }
        : undefined,
    [entryId, inScope, route?.owner, route?.id],
  );
  // Withdrawn once the page holds its answer.
  const pending =
    onRevealed && reveal?.entryId !== revealed ? reveal : undefined;
  const partial = channels.coverage === "partial";
  // The landing answers a linked visit, but never mounts without a channel:
  // a settled list with none answers it here.
  const unlisted = settled && !eligible.length ? pending?.entryId : undefined;
  const [notFound, setNotFound] = useState<string>();
  useEffect(() => {
    if (!unlisted) return;
    setNotFound(unlisted);
    if (!partial) onRevealed?.(unlisted);
  }, [unlisted, partial, onRevealed]);
  const visit = useRef({ navigation, navigator, reveal });
  visit.current = { navigation, navigator, reveal };
  const selectDetail = useCallback((key: string | undefined, name?: string) => {
    setDetail((current) =>
      !key
        ? undefined
        : current?.key === key && (name === undefined || current.name === name)
          ? current
          : { key, name: name ?? (current?.key === key ? current.name : "") },
    );
    const { navigation, navigator, reveal } = visit.current;
    if (
      key ||
      !reveal ||
      !navigator ||
      navigation?.target.kind !== "page" ||
      navigation.signal.aborted ||
      navigator.snapshot().entry.id !== navigation.entryId
    )
      return;
    // Closing the detail ends the visits that opened this workflow here: Back
    // returns to their opener and Forward leaves the detail closed.
    const page = withoutRoute(navigation.target);
    const pageKey = targetKey(page);
    navigator.dismiss((other) => {
      if (other.kind !== "page") return false;
      const opened = workflowRoute(other.route?.params);
      return (
        opened?.owner === reveal.owner &&
        opened.id === reveal.id &&
        targetKey(withoutRoute(other)) === pageKey
      );
    }, page);
  }, []);
  // The landing that reconciles the selection unmounts without channels.
  if (detail && !eligible.length) setDetail(undefined);
  const open = !!detail;
  useEffect(() => {
    const narrow = window.matchMedia?.("(max-width: 52rem)");
    if (!open || !narrow || !detailTarget) return;
    // Below 52rem the pane replaces the list, so focus left there moves to it.
    const handoff = () => {
      const focus = document.activeElement;
      if (
        narrow.matches &&
        (focus === document.body || mainRef.current?.contains(focus))
      )
        detailTarget.focus();
    };
    handoff();
    narrow.addEventListener("change", handoff);
    return () => narrow.removeEventListener("change", handoff);
  }, [open, detailTarget]);
  const channel = eligible.find((item) => item.id === selected);
  const mentionMembers = useWorkflowMentionMembers(session, channel);
  const agentMentions = useWorkflowAgentMentions(session.scope);
  useEffect(() => {
    if (
      !selected ||
      channel ||
      (!channels.channels.some(
        (item) => item.id === selected && (item.huddle || item.metadataPending),
      ) &&
        (channels.status !== "ready" || channels.coverage === "partial"))
    )
      return;
    setSelected("");
    setSelectedDefinition(undefined);
  }, [channel, channels, selected]);
  if (!capability) {
    return (
      <WorkflowsPanel>
        <WorkflowPageHeader />
        <div className="workflows-body">
          <p role="status">
            Workflow operations are unavailable from this host.
          </p>
        </div>
      </WorkflowsPanel>
    );
  }

  const openChannel = (
    next: string,
    definition?: WorkflowDefinition | "new",
  ) => {
    if (next && !eligible.some((item) => item.id === next)) return;
    setSelectedDefinition(definition);
    setSelected(next);
  };
  // The one owner of New workflow's availability, in the header and the landing.
  const beginCreate =
    capability.availability.save && creatable.length
      ? () => setCreateOpen(true)
      : undefined;
  const deleteWorkflow = (definition: WorkflowDefinition) => {
    if (deleting.current) return;
    const locked = workflowOperationLocked(
      capability.operations.snapshot(),
      definition,
    );
    if (locked) {
      setDeleteError(
        "Another workflow change is still being confirmed. Refresh and try again.",
      );
      openChannel("");
      return;
    }
    deleting.current = true;
    try {
      if (!capability.permissions.canDelete(definition))
        throw new Error(
          "You no longer have permission to delete this workflow. Refresh and try again.",
        );
      if (!capability.availability.delete)
        throw new Error("Workflow deletion is unavailable on this connection.");
      capability.delete(definition);
      setDeleteError(undefined);
    } catch (cause) {
      setDeleteError(
        cause instanceof Error
          ? cause.message
          : "Try again from the workflow menu.",
      );
    } finally {
      deleting.current = false;
      // Confirmation deliberately discards the editor draft, even if submission throws.
      openChannel("");
    }
  };

  return (
    <>
      <div
        ref={split.ref}
        className="workflows-split"
        data-side={detail ? "" : undefined}
      >
        <div className="workflows-main" ref={mainRef}>
          <WorkflowsPanel>
            <WorkflowPageHeader
              actions={
                <>
                  <IconButton
                    hint="familiar"
                    size="sm"
                    variant="ghost"
                    aria-label="New workflow"
                    title="New workflow"
                    aria-haspopup="dialog"
                    disabled={!beginCreate}
                    icon={<PlusIcon size="1rem" aria-hidden="true" />}
                    onClick={beginCreate}
                  />
                  <IconButton
                    hint="familiar"
                    size="sm"
                    variant="ghost"
                    aria-label="Refresh workflows"
                    title="Refresh workflows"
                    icon={
                      <ArrowsClockwiseIcon size="1rem" aria-hidden="true" />
                    }
                    onClick={() => setRefreshRequest((request) => request + 1)}
                  />
                </>
              }
            />
            <div className="workflows-body">
              {!eligible.length &&
                (channels.status === "loading" ||
                  (channels.status === "ready" && !settled)) && (
                  <p role="status">Reading channels…</p>
                )}
              {channels.status === "error" && (
                <div className="workflow-page-state">
                  <p role="alert" className="text-danger">
                    {channels.error ?? "Channels could not be read."}
                  </p>
                  <Button onClick={() => session.channels.refreshList?.()}>
                    Retry channels
                  </Button>
                </div>
              )}
              {settled && !eligible.length && (
                <div className="workflow-page-state">
                  <p>No channels are available in this community.</p>
                </div>
              )}
              {channels.coverage === "partial" && (
                <p className="text-secondary">The channel list is partial.</p>
              )}
              {eligible.length > 0 && (
                <WorkflowLanding
                  session={session}
                  capability={capability}
                  channels={eligible}
                  channelsSettled={settled}
                  channelsPartial={partial}
                  filter={filter}
                  onFilterChange={setFilter}
                  detailTarget={detailTarget}
                  selected={detail?.key}
                  onSelect={selectDetail}
                  reveal={pending}
                  onRevealed={onRevealed}
                  onCreate={beginCreate}
                  onDelete={deleteWorkflow}
                  onOpen={(definition, nextChannel) =>
                    openChannel(nextChannel.id, definition)
                  }
                  refreshRequest={refreshRequest}
                  saveReadback={saveReadback}
                  viewer={viewer}
                />
              )}
            </div>
          </WorkflowsPanel>
        </div>
        {detail && (
          <aside className="workflows-side">
            {split.handle}
            <Panel aria-label="Workflow details">
              <PanelWorkspace
                focusOnMount={false}
                adoptSelection={detail.key}
                value={detail.key}
                select={() => {}}
                items={[
                  {
                    id: detail.key,
                    label: detail.name,
                    icon: <LightningIcon size="1rem" />,
                    content: (
                      <section
                        className="workflow-detail-host"
                        ref={setDetailTarget}
                        aria-label={`${detail.name} details`}
                        tabIndex={-1}
                      />
                    ),
                    close: () => selectDetail(undefined),
                  },
                ]}
              />
            </Panel>
          </aside>
        )}
      </div>
      {notFound && (
        <ToastNotice
          title={WORKFLOW_NOT_FOUND}
          onDismiss={() => setNotFound(undefined)}
        />
      )}
      {deleteError && (
        <ToastNotice
          title="Couldn't start deletion"
          description={deleteError}
          onDismiss={() => setDeleteError(undefined)}
        />
      )}
      {channel && selectedDefinition ? (
        <WorkflowMentionMembers.Provider value={mentionMembers}>
          <WorkflowChannel
            key={`${channel.id}:${
              typeof selectedDefinition === "object"
                ? selectedDefinition.revision
                : selectedDefinition
            }`}
            capability={capability}
            channelId={channel.id}
            channel={channel}
            initialSelection={selectedDefinition}
            onSaveReadback={setSaveReadback}
            onDelete={deleteWorkflow}
            viewer={viewer}
            agentMentions={agentMentions}
            onClose={() => openChannel("")}
          />
        </WorkflowMentionMembers.Provider>
      ) : null}
      <WorkflowWebhookSecrets capability={capability} />
      {createOpen && (
        <WorkflowEditor
          create
          chooseChannel
          yaml={formStateToYaml({
            ...DEFAULT_FORM_STATE,
            name: "Untitled workflow",
          })}
          onChange={() => {}}
          onSave={() => {}}
          onCancel={() => setCreateOpen(false)}
          scope={
            <WorkflowChannelPicker
              channels={creatable}
              profiles={session.profiles}
              names={session.names}
              onSelect={(id) => {
                setCreateOpen(false);
                openChannel(id, "new");
              }}
            />
          }
        />
      )}
    </>
  );
}

function WorkflowPageHeader({ actions }: { actions?: ReactNode }) {
  return (
    <PanelHeader
      title={
        <PanelHeaderLabel
          title="Workflows"
          icon={<LightningIcon size="1rem" />}
        />
      }
      actions={actions}
    />
  );
}
